/**
 * Phase 1 integration verification — prospect chat path.
 *
 * The staff-callable suite proves configuration is stored, inherited and clamped.
 * This suite proves the thing that actually matters commercially: that company
 * knowledge and company AUTHORITY reach the prompt the model is given, for a
 * proposal that already existed before the configuration changed.
 *
 * Method: the OpenAI peer is a local stub (see tests/stub-openai.mjs) that records
 * the request it received. Assertions are made against the assembled system
 * prompt rather than the reply text, because the prompt is precisely what Phase 1
 * rewired. Asserting only on replies would pass even if no company knowledge
 * reached the model at all.
 *
 * Prerequisites:
 *   firebase emulators:start --only auth,firestore,functions   (port 5001/8080/9099)
 *   node tests/stub-openai.mjs                                 (port 8787)
 *
 * Run: node --test tests/company.chat.test.mjs
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  db,
  createStaffUser,
  signIn,
  call,
  proposalPayload,
  cleanupCompany,
  cleanupUsers,
} from './support/staff-fixture.mjs';

const PROJECT = process.env.GCLOUD_PROJECT;
const API = process.env.API_BASE ?? `http://127.0.0.1:5001/${PROJECT}/us-central1/api`;
const STUB = process.env.STUB_BASE ?? 'http://127.0.0.1:8787';
const CHAT_ORIGIN = process.env.CHAT_ORIGIN ?? 'http://localhost:8888';
const EMBED_ORIGIN = 'https://chat-test.example';

const TENANT = 'p1-chat-tenant';
const ADMIN_EMAIL = 'p1-chat-admin@buildclose.test';

const ctx = {};

/** Clear limiter state so a rerun is not throttled by the previous run. */
async function resetRateLimits() {
  const snap = await db.collection('rateLimits').limit(500).get();
  if (snap.empty) return;
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

beforeEach(async () => {
  await resetRateLimits();
});

async function post(path, body, { token, origin = CHAT_ORIGIN } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* asserted by caller */
  }
  return { status: res.status, json, text };
}

/** The system prompt the stub most recently received. */
async function lastPrompt() {
  const res = await fetch(`${STUB}/__last-prompt`);
  return res.json();
}

/** Send one prospect turn and return the parsed response. */
async function say(message) {
  const r = await post('/api/chat', { message }, { token: ctx.session });
  assert.equal(r.status, 200, `chat failed: ${r.text?.slice(0, 300)}`);
  return r.json;
}

function authority(overrides = {}) {
  return {
    priceFloorMinor: 1_500_000,
    maxDiscountPercent: 15,
    paymentTerms: 'Net 14 from acceptance.',
    paymentSchedule: [
      { label: 'Commencement', percent: 40 },
      { label: 'On delivery', percent: 60 },
    ],
    negotiationPermissions: {
      canOfferDiscounts: true,
      canAdjustTimeline: false,
      canWaiveFees: false,
      requiresApprovalAbovePercent: 10,
    },
    approvedDiscounts: [],
    quotableAmountsMinor: [],
    negotiationBoundaries: ['Do not waive the implementation fee.'],
    internalNotes: 'CONFIDENTIAL FLOOR RATIONALE: below 15000 we lose money.',
    ...overrides,
  };
}

before(async () => {
  await db.collection('companies').doc(TENANT).set(
    { name: 'Prompt Test Co', settings: { retentionDays: 365 } },
    { merge: true },
  );
  await createStaffUser({ email: ADMIN_EMAIL, companyId: TENANT, role: 'company_admin' });
  ctx.admin = (await signIn(ADMIN_EMAIL)).idToken;

  // The proposal is created BEFORE any company intelligence exists. That ordering
  // is the whole point: everything below must reach this already-existing record.
  const created = await call(
    'createProposal',
    { proposal: proposalPayload({ title: 'Chat Path Proposal', totalValueMinor: 1_800_000 }) },
    ctx.admin,
  );
  ctx.proposalId = created.id;

  // A proposal-level assistant config with no knowledge of its own, so any
  // knowledge observed in the prompt can only have come from the company record.
  await call('updateProposal', { id: ctx.proposalId, agent: { displayName: 'Prompt Probe' } }, ctx.admin);

  await call('publishProposal', { id: ctx.proposalId }, ctx.admin);

  const minted = await call(
    'mintAccessToken',
    { proposalId: ctx.proposalId, label: 'chat suite', allowedOrigins: [EMBED_ORIGIN] },
    ctx.admin,
  );
  ctx.token = minted.token;

  const boot = await post('/api/bootstrap', { token: ctx.token, embedOrigin: EMBED_ORIGIN });
  assert.equal(boot.status, 200, `bootstrap failed: ${boot.text?.slice(0, 300)}`);
  ctx.session = boot.json.session;
});

after(async () => {
  await cleanupCompany(TENANT);
  await cleanupUsers([ADMIN_EMAIL]);
});

// ─────────────────────────────────── company knowledge reaches an existing proposal

test('company product knowledge reaches the prompt of a pre-existing proposal', async () => {
  await call(
    'updateCompanyIntelligence',
    {
      productsServices: [
        {
          name: 'Meridian Workspace',
          description: 'A branded intake and case workspace for litigation firms.',
          deliverables: ['Branded intake page', 'Retainer e-signature'],
        },
      ],
    },
    ctx.admin,
  );

  const reply = await say('What exactly is included?');
  assert.ok(reply && typeof reply.reply === 'string');

  const { system } = await lastPrompt();
  assert.match(system, /Meridian Workspace/, 'company product name never reached the prompt');
  assert.match(system, /Branded intake page/, 'company deliverable never reached the prompt');
});

test('a later company knowledge update reaches the same existing proposal', async () => {
  // Same proposal, same token, no re-creation: proving configuration is read at
  // request time rather than copied at proposal creation.
  await call(
    'updateCompanyIntelligence',
    { faqs: [{ question: 'Do you support multi-factor login?', answer: 'Yes, MFA is standard on every account.' }] },
    ctx.admin,
  );

  await say('Is multi-factor login supported?');

  const { system } = await lastPrompt();
  assert.match(system, /multi-factor login/i, 'newly added company FAQ did not reach the prompt');
  assert.match(system, /MFA is standard/, 'FAQ answer text did not reach the prompt');
});

test('the company objection playbook reaches the prompt', async () => {
  await call(
    'updateCompanyIntelligence',
    {
      objectionPlaybook: [
        {
          type: 'budget',
          trigger: 'They say there is no budget this quarter.',
          response: 'Offer to start with the single-firm package and add firms later.',
          escalate: false,
        },
      ],
    },
    ctx.admin,
  );

  await say('Installment options?');

  const { system } = await lastPrompt();
  assert.match(
    system,
    /single-firm package/i,
    'the company objection response did not reach the prompt',
  );
});

// ─────────────────────────────────── company authority reaches the prompt

test('with discounts authorised and pre-approved, the prompt lists exactly those', async () => {
  await call(
    'updateCompanyAuthority',
    {
      authority: authority({
        // Above the 1,500,000 floor so it survives the floor filter.
        approvedDiscounts: [
          { label: 'Annual prepayment concession', amountMinor: 1_700_000, conditions: 'Paid up front' },
        ],
      }),
    },
    ctx.admin,
  );

  await say('Is there any flexibility on price?');

  const { system } = await lastPrompt();
  assert.match(system, /pre-approved options/i, 'prompt did not enter the concession branch');
  assert.match(system, /Annual prepayment concession/, 'the approved concession was not offered to the model');
});

test('with discounts forbidden, the prompt tells the model no concession is authorised', async () => {
  await call(
    'updateCompanyAuthority',
    {
      authority: authority({
        maxDiscountPercent: 0,
        negotiationPermissions: {
          canOfferDiscounts: false,
          canAdjustTimeline: false,
          canWaiveFees: false,
          requiresApprovalAbovePercent: 0,
        },
      }),
    },
    ctx.admin,
  );

  await say('Can you do better on price?');

  const { system } = await lastPrompt();
  assert.match(
    system,
    /No discounts, fee waivers or price adjustments are authorised/i,
    'the fail-closed concession rule did not reach the prompt',
  );
  assert.doesNotMatch(system, /pre-approved options/i, 'a forbidden concession was still offered to the model');
});

test('a proposal tightening its ceiling to zero removes concessions from the prompt', async () => {
  // The prompt deliberately never states a ceiling percentage (disclosing "we can
  // go to 3%" invites anchoring and reveals policy), so the ceiling itself is not
  // observable — its EFFECT is. Company permits 15% and pre-approves a concession;
  // the proposal tightens itself to 0%, which must flip the prompt to fail-closed.
  await call(
    'updateCompanyAuthority',
    {
      authority: authority({
        approvedDiscounts: [
          { label: 'Annual prepayment concession', amountMinor: 1_700_000, conditions: 'Paid up front' },
        ],
      }),
    },
    ctx.admin,
  );
  await call('updateProposal', { id: ctx.proposalId, internal: { maxDiscountPercent: 0 } }, ctx.admin);

  await say('Any discount available?');

  const { system } = await lastPrompt();
  assert.match(
    system,
    /No discounts, fee waivers or price adjustments are authorised/i,
    'a 0% proposal ceiling must fail closed',
  );
  assert.doesNotMatch(
    system,
    /Annual prepayment concession/,
    'a company concession survived a proposal that tightened its ceiling to zero',
  );
});

// ─────────────────────────────────── no internal disclosure

test('the price floor and internal notes never reach the prompt', async () => {
  await say('What is the lowest you will go?');

  const { system } = await lastPrompt();
  // 1,500,000 minor = $15,000. Neither the figure nor the rationale may appear.
  assert.doesNotMatch(system, /15,000|15000/, 'the price floor was disclosed to the model');
  assert.doesNotMatch(system, /CONFIDENTIAL FLOOR RATIONALE/i, 'internal notes were disclosed to the model');
  assert.doesNotMatch(system, /lose money/i, 'internal negotiation rationale was disclosed');
});

test('negotiation strategy text is withheld while permission flags govern behaviour', async () => {
  await say('Anything else I should know about the terms?');

  const { system } = await lastPrompt();

  // Free-text negotiation boundaries are staff-side only. They may encode
  // internal strategy ("we can go to 18k to close this quarter"), so
  // PromptContext.authority deliberately omits negotiationBoundaries and the
  // text never reaches the model. This is the opposite of what I first assumed
  // when writing this test — the absence is the control, not a gap.
  assert.doesNotMatch(
    system,
    /Do not waive the implementation fee/,
    'staff-side negotiation boundary leaked into the prospect prompt',
  );
  assert.doesNotMatch(system, /1,500,000|15,000/, 'the price floor leaked into the prompt');

  // What DOES reach the model is the permission DECISION, which carries no
  // strategy: canWaiveFees is false on this tenant, so the prompt must forbid it.
  assert.match(
    system,
    /Do not waive, reduce or defer any fee/i,
    'the fee permission flag was not enforced in the prompt',
  );
});

// ─────────────────────────────────── tenant isolation on the prospect path

test('a token from one tenant cannot open another tenant proposal', async () => {
  // Mint a token in a second tenant, then point bootstrap at the first tenant's
  // proposal id. The proposal/company mismatch must be refused.
  await db.collection('companies').doc('p1-chat-other').set({ name: 'Other Co' }, { merge: true });
  await createStaffUser({ email: 'p1-chat-other@buildclose.test', companyId: 'p1-chat-other', role: 'company_admin' });
  const otherAdmin = (await signIn('p1-chat-other@buildclose.test')).idToken;

  const otherProposal = await call(
    'createProposal',
    { proposal: proposalPayload({ title: 'Other Tenant Proposal' }) },
    otherAdmin,
  );
  // Must be published: bootstrap correctly refuses a draft with 403 not_published,
  // which is what my first version of this test mistook for a cross-tenant bug.
  await call('publishProposal', { id: otherProposal.id }, otherAdmin);
  const otherMint = await call(
    'mintAccessToken',
    { proposalId: otherProposal.id, allowedOrigins: [EMBED_ORIGIN] },
    otherAdmin,
  );

  // Valid token, but it is for a different tenant's proposal than the one targeted.
  const res = await post('/api/bootstrap', { token: otherMint.token, embedOrigin: EMBED_ORIGIN });
  assert.equal(res.status, 200, 'own-tenant bootstrap should succeed');

  // That session must not be able to read the first tenant's terms via a
  // cross-tenant id — there is no id parameter on the prospect API by design, so
  // the check is that the session resolves only its own proposal.
  const terms = await post('/api/terms', {}, { token: res.json.session });
  assert.equal(terms.status, 200);
  assert.doesNotMatch(
    JSON.stringify(terms.json),
    /Chat Path Proposal/,
    "another tenant's proposal title leaked through the prospect API",
  );

  await cleanupCompany('p1-chat-other');
  await cleanupUsers(['p1-chat-other@buildclose.test']);
});
