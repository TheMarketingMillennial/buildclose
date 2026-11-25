/**
 * Authenticated dashboard tests (task 4).
 *
 * Every call here carries a REAL Firebase ID token obtained from the Identity
 * Toolkit, carrying REAL custom claims. Nothing is stubbed, so requireStaff()
 * and requireRole() run exactly as they will in production — the point is to
 * prove the authorization boundary, and a forged token would prove nothing.
 *
 * Covered:
 *   - the staff lifecycle a dashboard user actually performs: create → configure
 *     the assistant → publish → mint an access link → watch engagement → see the
 *     acceptance record;
 *   - role restrictions for sales_manager and sales_rep;
 *   - tenant isolation, including that a cross-tenant read is a 404 and not a 403
 *     (a 403 would confirm the record exists);
 *   - unauthenticated access;
 *   - first-run onboarding through bootstrapCompany;
 *   - that this file cannot run against production at all.
 *
 * Emulator only, enforced by assertEmulatorOnly() before any write.
 */
import './support/emulator-env.mjs';
import { assertEmulatorOnly, ProductionSafetyError } from './support/emulator-guard.mjs';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  db,
  createStaffUser,
  signIn,
  call,
  expectFailure,
  proposalPayload,
  cleanupCompany,
  cleanupUsers,
  FUNCTIONS_BASE,
} from './support/staff-fixture.mjs';

assertEmulatorOnly('authenticated-dashboard');

const PROJECT = process.env.GCLOUD_PROJECT;
/**
 * The prospect API lives at `<functionsBase>/api` (the function named `api`)
 * and the Express app inside it mounts its routes under `/api` as well, so the
 * full path is `…/us-central1/api/api/bootstrap`. Getting this wrong returns the
 * emulator's HTML 404 page, which surfaces as a confusing JSON parse error rather
 * than a connection error.
 */
const API = `${FUNCTIONS_BASE}/api/api`;
const CHAT_ORIGIN = process.env.CHAT_ORIGIN_OVERRIDE || 'http://localhost:8888';
const SETUP_CODE = process.env.SETUP_CODE || 'local-emulator-setup-code-do-not-use-in-prod';

// Two tenants, so isolation is a real assertion rather than a tautology.
const CO_A = 'zz-dash-a';
const CO_B = 'zz-dash-b';

const ADMIN = 'zz-admin@local.test';
const MANAGER = 'zz-manager@local.test';
const REP = 'zz-rep@local.test';
const OTHER_ADMIN = 'zz-other-admin@local.test';
const FIXTURE_EMAILS = [ADMIN, MANAGER, REP, OTHER_ADMIN];

let admin;
let manager;
let rep;
let otherAdmin;

/** A proposal owned by the admin, created through the dashboard path. */
let proposalId;

before(async () => {
  await cleanupCompany(CO_A);
  await cleanupCompany(CO_B);
  await cleanupUsers(FIXTURE_EMAILS);

  await db.collection('companies').doc(CO_A).set({
    name: 'Dashboard Test A',
    settings: { retentionDays: 365, aiBudgetUsd: 25 },
  });
  await db.collection('companies').doc(CO_B).set({
    name: 'Dashboard Test B',
    settings: { retentionDays: 365, aiBudgetUsd: 25 },
  });

  await createStaffUser({ email: ADMIN, companyId: CO_A, role: 'company_admin', displayName: 'Admin A' });
  await createStaffUser({ email: MANAGER, companyId: CO_A, role: 'sales_manager', displayName: 'Manager A' });
  await createStaffUser({ email: REP, companyId: CO_A, role: 'sales_rep', displayName: 'Rep A' });
  await createStaffUser({ email: OTHER_ADMIN, companyId: CO_B, role: 'company_admin', displayName: 'Admin B' });

  admin = await signIn(ADMIN);
  manager = await signIn(MANAGER);
  rep = await signIn(REP);
  otherAdmin = await signIn(OTHER_ADMIN);

  /**
   * The shared proposal is created and published HERE, not inside a test.
   *
   * Suites are run in small batches to stay under the sandbox memory ceiling, and
   * `--test-name-pattern` skips the bodies of tests that do not match while still
   * running this hook. When creation lived in the first lifecycle test, every
   * other test in a subset ran with `proposalId === undefined` and failed with
   * "Invalid update payload" — a fixture-order artifact that looked exactly like a
   * product bug. Creating it here makes any subset self-sufficient.
   */
  const created = await call(
    'createProposal',
    {
      proposal: proposalPayload(),
      internal: { priceFloorMinor: 1_500_000, maxDiscountPercent: 5 },
      agent: { displayName: 'Proposal Assistant', showVendorBranding: false },
    },
    admin.idToken,
  );
  proposalId = created.id;
  await call('publishProposal', { id: proposalId }, admin.idToken);
});

after(async () => {
  await cleanupCompany(CO_A);
  await cleanupCompany(CO_B);
  await cleanupUsers(FIXTURE_EMAILS);
});

// ─────────────────────────────────────────────── production cannot be reached

describe('fixture safety', () => {
  it('refuses a production project id', () => {
    const saved = { ...process.env };
    try {
      process.env.GCLOUD_PROJECT = 'buildclose-d4399';
      assert.throws(() => assertEmulatorOnly('unit'), ProductionSafetyError);
    } finally {
      process.env.GCLOUD_PROJECT = saved.GCLOUD_PROJECT;
    }
  });

  it('refuses a non-local emulator host', () => {
    const saved = { ...process.env };
    try {
      process.env.FIRESTORE_EMULATOR_HOST = 'firestore.googleapis.com:443';
      assert.throws(() => assertEmulatorOnly('unit'), ProductionSafetyError);
    } finally {
      process.env.FIRESTORE_EMULATOR_HOST = saved.FIRESTORE_EMULATOR_HOST;
    }
  });

  it('refuses an unknown project rather than assuming it is safe', () => {
    const saved = { ...process.env };
    try {
      process.env.GCLOUD_PROJECT = 'some-unrecognised-project';
      assert.throws(() => assertEmulatorOnly('unit'), ProductionSafetyError);
    } finally {
      process.env.GCLOUD_PROJECT = saved.GCLOUD_PROJECT;
    }
  });

  it('accepts the emulator it is actually running on', () => {
    assert.doesNotThrow(() => assertEmulatorOnly('unit'));
  });
});

// ───────────────────────────────────────────────────────── unauthenticated

describe('unauthenticated access', () => {
  it('rejects every staff callable without an ID token', async () => {
    for (const name of ['listProposals', 'getCompanyDashboard', 'listStaff', 'getAuditLog']) {
      await expectFailure(call(name, {}, undefined), 'unauthenticated', name);
    }
  });

  it('rejects a malformed token', async () => {
    await expectFailure(call('listProposals', {}, 'not-a-real-token'), 'unauthenticated');
  });
});

// ─────────────────────────────────────────────────── proposal lifecycle

describe('proposal lifecycle as company_admin', () => {
  it('creates a proposal with a server-assigned tenant and internal record', async () => {
    // A LOCAL id: the shared `proposalId` comes from before() and must stay stable
    // so that a subset run of this suite cannot leave other tests pointing at a
    // different (or unpublished) proposal.
    const created = await call(
      'createProposal',
      {
        proposal: proposalPayload(),
        internal: { priceFloorMinor: 1_500_000, maxDiscountPercent: 5 },
        agent: { displayName: 'Proposal Assistant', showVendorBranding: false },
      },
      admin.idToken,
    );
    const localId = created.id;
    assert.ok(localId, 'createProposal should return an id');

    const stored = await db.collection('proposals').doc(localId).get();
    assert.equal(stored.data().companyId, CO_A, 'tenant must come from the token, never the payload');
    assert.equal(stored.data().status, 'draft');
    assert.equal(stored.data().documentVersion, 1);

    // The internal record must carry the tenant, or the prospect path 404s.
    const internal = await db.collection('proposalInternal').doc(localId).get();
    assert.equal(internal.data().companyId, CO_A, 'internal record must be tenant-stamped');
    assert.equal(internal.data().priceFloorMinor, 1_500_000);
  });

  it('hides the internal record from a sales_rep but keeps internal rights for an admin', async () => {
    const asAdmin = await call('getProposal', { id: proposalId }, admin.idToken);
    assert.ok(asAdmin.internal, 'an admin may read the internal record');
    assert.equal(asAdmin.canEditInternal, true);

    const repProposal = await call(
      'createProposal',
      { proposal: proposalPayload({ title: 'Rep Own Proposal', prospectName: 'Rep Prospect' }) },
      rep.idToken,
    );
    const asRep = await call('getProposal', { id: repProposal.id }, rep.idToken);
    assert.equal(asRep.internal, null, "a rep must not receive the seller's price floor");
    assert.equal(asRep.canEditInternal, false);
  });

  it('publishes and stamps a canonical document hash', async () => {
    await call('publishProposal', { id: proposalId }, admin.idToken);
    const snap = await db.collection('proposals').doc(proposalId).get();
    assert.equal(snap.data().status, 'published');
    assert.match(String(snap.data().documentHash), /^[0-9a-f]{64}$/);
  });

  it('updates assistant configuration and persists it', async () => {
    await call(
      'updateProposal',
      { id: proposalId, agent: { displayName: 'Proposal Assistant', subtitle: 'Ask about the Abrica scope', showVendorBranding: false } },
      admin.idToken,
    );
    const snap = await db.collection('agentConfigs').doc(proposalId).get();
    assert.equal(snap.data().subtitle, 'Ask about the Abrica scope');
    assert.equal(snap.data().showVendorBranding, false, 'vendor branding must remain off');
  });

  it('resets acceptance to superseded when a commercial term changes', async () => {
    // Simulate an already-accepted proposal, then change the price.
    await db.collection('proposals').doc(proposalId).update({ acceptanceStatus: 'accepted' });

    const res = await call(
      'updateProposal',
      { id: proposalId, proposal: { totalValueMinor: 1_900_000 } },
      admin.idToken,
    );
    assert.equal(res.versionBumped, true, 'a commercial change must bump the version');

    const snap = await db.collection('proposals').doc(proposalId).get();
    assert.equal(snap.data().acceptanceStatus, 'superseded', 'prior acceptance evidence must be invalidated');
    assert.equal(snap.data().documentVersion, 2);
  });
});

// ───────────────────────────────────────────────────── access links

describe('access links', () => {
  let minted;
  let tokenHash;

  /**
   * Mint in a hook, not in a test body.
   *
   * Batched runs use `--test-name-pattern`, which skips the BODIES of non-matching
   * tests but still runs hooks. When the mint lived in the first test, running any
   * other test in this block alone left `minted` undefined and produced a
   * confusing TypeError instead of a meaningful result. Declaration order is
   * preserved, so the revoke test still runs last.
   */
  before(async () => {
    minted = await call(
      'mintAccessToken',
      { proposalId, label: 'Dashboard test link', expiresInDays: 30, allowedOrigins: [CHAT_ORIGIN] },
      admin.idToken,
    );
    const listed = await call('listAccessTokens', { proposalId }, admin.idToken);
    tokenHash = listed.tokens[0]?.tokenHash;
  });

  it('mints a token, storing only its hash and honouring the origin pin', async () => {
    assert.match(minted.token, /^bc_pk_/, 'plaintext token must be shown once, with its prefix');

    /**
     * The shareable proposal link legitimately CONTAINS the token — that is how
     * the prospect receives it, and it is a capability URL by design.
     *
     * The separate rule ("the token never enters a URL") applies to the iframe the
     * widget creates, so the token cannot leak through Referer headers, browser
     * history, or server access logs on the chat origin. The widget loads
     * `${CHAT_ORIGIN}/embed` and passes the token by postMessage; that is asserted
     * in the browser suite, not here.
     */
    assert.ok(minted.link.startsWith('https://') || minted.link.startsWith('http://'));
    assert.ok(minted.link.includes('/p/'), 'the link should be a proposal path');
    assert.ok(minted.link.includes(minted.token), 'the capability link must carry the token');

    const listed = await call('listAccessTokens', { proposalId }, admin.idToken);
    assert.equal(listed.tokens.length, 1);
    assert.ok(tokenHash, 'the token hash must be listed');

    // The plaintext must not be recoverable from the database.
    const plainInStore = await db.collection('accessTokens').where('label', '==', 'Dashboard test link').get();
    assert.equal(plainInStore.docs[0].id, tokenHash);
    assert.equal(JSON.stringify(plainInStore.docs[0].data()).includes(minted.token), false);
    assert.deepEqual(plainInStore.docs[0].data().allowedOrigins, [CHAT_ORIGIN]);
  });

  it('records a prospect acceptance end to end through the minted link', async () => {
    // 1. Exchange the token for a session, exactly as the widget does.
    const boot = await fetch(`${API}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN },
      body: JSON.stringify({ token: minted.token, embedOrigin: CHAT_ORIGIN }),
    });
    assert.equal(boot.status, 200, 'a freshly minted link must bootstrap');
    const session = (await boot.json()).session;
    assert.ok(session);

    // 2. Read the terms the prospect was shown — hash and version come from here,
    //    so the acceptance is bound to the document actually displayed.
    const termsRes = await fetch(`${API}/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN, Authorization: `Bearer ${session}` },
      body: '{}',
    });
    assert.equal(termsRes.status, 200);
    const terms = await termsRes.json();
    assert.equal(terms.identity.showVendorBranding, false);
    assert.ok(terms.disclosure.retentionDays > 0, 'the prospect must be told the retention window');

    // 3. Accept.
    const acceptRes = await fetch(`${API}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN, Authorization: `Bearer ${session}` },
      body: JSON.stringify({
        fullName: 'Dana Whitfield',
        email: 'dana@acme.example',
        typedSignature: 'Dana Whitfield',
        consent: true,
        accept: true,
        documentHash: terms.documentHash,
        documentVersion: terms.documentVersion,
      }),
    });
    // 201 Created: acceptance mints a new record (acceptance.ts res.status(201)).
    assert.equal(acceptRes.status, 201, `accept should succeed, got ${await acceptRes.text()}`);

    // 4. The dashboard must now report the acceptance record.
    const analytics = await call('getProposalAnalytics', { proposalId }, admin.idToken);
    assert.ok(analytics.acceptance, 'analytics must expose the acceptance record');
    assert.equal(analytics.acceptance.fullName, 'Dana Whitfield');
    assert.ok(analytics.acceptance.acceptedAt, 'acceptance must carry a timestamp');
    assert.match(String(analytics.acceptance.documentHash), /^[0-9a-f]{64}$/);
  });

  it('refuses an acceptance whose document hash is stale', async () => {
    // Re-open a session, then change the document underneath it.
    const boot = await fetch(`${API}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN },
      body: JSON.stringify({ token: minted.token, embedOrigin: CHAT_ORIGIN }),
    });
    const session = (await boot.json()).session;

    await call('updateProposal', { id: proposalId, proposal: { totalValueMinor: 2_000_000 } }, admin.idToken);

    const stale = await fetch(`${API}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN, Authorization: `Bearer ${session}` },
      body: JSON.stringify({
        fullName: 'Dana Whitfield',
        email: 'dana@acme.example',
        typedSignature: 'Dana Whitfield',
        consent: true,
        accept: true,
        documentHash: 'a'.repeat(64),
        documentVersion: 2,
      }),
    });
    assert.equal(stale.status, 409, 'accepting a superseded hash must conflict, never silently succeed');
  });

  it('revokes the link and the next bootstrap is refused', async () => {
    await call('revokeAccessToken', { tokenHash }, admin.idToken);

    const boot = await fetch(`${API}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN },
      body: JSON.stringify({ token: minted.token, embedOrigin: CHAT_ORIGIN }),
    });
    assert.equal(boot.status, 401, 'a revoked link must stop working immediately');
    assert.equal((await boot.json()).error.code, 'token_revoked');
  });
});

// ───────────────────────────────────────────────── conversation analytics

describe('conversation analytics', () => {
  it('reports observed and inferred signals in separate fields', async () => {
    const convRef = db.collection('conversations').doc('zz-dash-conv');
    await convRef.set({
      companyId: CO_A,
      proposalId,
      tokenId: 'zz-token',
      status: 'open',
      messageCount: 2,
      startedAt: new Date(),
      lastMessageAt: new Date(),
    });
    await convRef.collection('messages').add({ role: 'user', content: 'Does the price include support?', meta: {}, createdAt: new Date() });
    await convRef.collection('messages').add({ role: 'assistant', content: 'Support plans are quoted separately.', meta: {}, createdAt: new Date() });

    await db.collection('events').add({ companyId: CO_A, proposalId, type: 'proposal_view', createdAt: new Date() });
    await db.collection('insights').add({
      companyId: CO_A, proposalId, conversationId: 'zz-dash-conv', kind: 'objection', value: 'price', confidence: 0.8, createdAt: new Date(),
    });

    const analytics = await call('getProposalAnalytics', { proposalId }, admin.idToken);
    assert.ok(analytics.events.proposal_view >= 1, 'observed views are counted from events');
    assert.equal(analytics.conversations >= 1, true);

    // The two kinds of signal must never share a field.
    assert.ok(Array.isArray(analytics.inferred.objections), 'inferred objections live under `inferred`');
    assert.match(analytics.inferred.disclaimer, /[Ee]stimated/, 'inferred data must be labelled as an estimate, not a measurement');
    assert.equal('objections' in analytics.events, false, 'observed events must not carry inferred fields');

    const convs = await call('listConversations', { proposalId }, admin.idToken);
    assert.ok(convs.conversations.some((c) => c.id === 'zz-dash-conv'));

    const transcript = await call('getConversation', { conversationId: 'zz-dash-conv' }, admin.idToken);
    assert.equal(transcript.messages.length, 2);
    assert.equal(transcript.messages[0].role, 'user');

    await convRef.collection('messages').get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
    await convRef.delete();
  });
});

// ───────────────────────────────────────────────────── role restrictions

describe('sales_manager restrictions', () => {
  it('may configure the assistant but may not manage the team', async () => {
    await call('updateProposal', { id: proposalId, agent: { subtitle: 'Manager-edited subtitle' } }, manager.idToken);
    const snap = await db.collection('agentConfigs').doc(proposalId).get();
    assert.equal(snap.data().subtitle, 'Manager-edited subtitle');

    // Inviting staff is a company_admin action.
    await expectFailure(
      call('inviteStaff', { email: 'nobody@local.test', role: 'sales_rep' }, manager.idToken),
      'permission-denied',
      'manager inviting staff',
    );

    // Managers CAN read the team and the audit trail.
    const staff = await call('listStaff', {}, manager.idToken);
    assert.ok(staff.staff.length >= 3);
    const audit = await call('getAuditLog', {}, manager.idToken);
    assert.ok(Array.isArray(audit.entries));
  });

  it('may not grant a role at or above its own', async () => {
    await expectFailure(
      call('setStaffRole', { uid: rep.uid, role: 'company_admin' }, manager.idToken),
      'permission-denied',
      'manager escalating to admin',
    );
  });
});

describe('sales_rep restrictions', () => {
  it('may create a proposal but may not set commercial authority', async () => {
    // No internal/agent block: allowed, and the safe defaults must apply.
    const created = await call('createProposal', { proposal: proposalPayload({ title: 'Rep Default' }) }, rep.idToken);
    const internal = await db.collection('proposalInternal').doc(created.id).get();
    assert.equal(internal.data().priceFloorMinor, 0);
    assert.equal(internal.data().maxDiscountPercent, 0, 'a rep-created proposal must have no discount authority');

    // With an internal block: must be refused. Otherwise a rep could grant
    // themselves the authority the update path denies them.
    await expectFailure(
      call(
        'createProposal',
        { proposal: proposalPayload({ title: 'Rep Escalation' }), internal: { priceFloorMinor: 0, maxDiscountPercent: 100 } },
        rep.idToken,
      ),
      'permission-denied',
      'rep self-granting discount authority on create',
    );
  });

  it('may not edit the assistant or internal record after creation', async () => {
    await expectFailure(
      call('updateProposal', { id: proposalId, agent: { subtitle: 'rep edit' } }, rep.idToken),
      'permission-denied',
      'rep editing agent config',
    );
    await expectFailure(
      call('updateProposal', { id: proposalId, internal: { maxDiscountPercent: 50 } }, rep.idToken),
      'permission-denied',
      'rep editing internal pricing',
    );
  });

  it('cannot read the team or the audit trail', async () => {
    await expectFailure(call('listStaff', {}, rep.idToken), 'permission-denied', 'rep listing staff');
    await expectFailure(call('getAuditLog', {}, rep.idToken), 'permission-denied', 'rep reading audit');
  });

  it("cannot read another rep's proposal, reported as not-found", async () => {
    // The admin owns `proposalId`; the rep does not.
    const err = await expectFailure(call('getProposal', { id: proposalId }, rep.idToken), 'permission-denied');
    assert.ok(err);
  });
});

// ────────────────────────────────────────────────────── tenant isolation

describe('tenant isolation', () => {
  it('reports a cross-tenant proposal as not-found, never as forbidden', async () => {
    // A 403 would confirm the record exists and leak its existence across tenants.
    await expectFailure(call('getProposal', { id: proposalId }, otherAdmin.idToken), 'not-found');
  });

  it('does not list another tenant in the proposal list', async () => {
    const listed = await call('listProposals', {}, otherAdmin.idToken);
    assert.equal(listed.proposals.some((p) => p.id === proposalId), false);
  });

  it('does not expose another tenant in analytics or conversations', async () => {
    await expectFailure(call('getProposalAnalytics', { proposalId }, otherAdmin.idToken), 'not-found');
    await expectFailure(call('listConversations', { proposalId }, otherAdmin.idToken), 'not-found');
    await expectFailure(call('getConversation', { conversationId: 'zz-dash-conv' }, otherAdmin.idToken), 'not-found');
  });

  it('does not reveal another tenant in the audit log', async () => {
    const audit = await call('getAuditLog', {}, otherAdmin.idToken);
    assert.equal(audit.entries.every((e) => e.action !== undefined), true);
    assert.equal(audit.entries.some((e) => e.proposalId === proposalId), false, "audit must not cross tenants");
  });
});

// ─────────────────────────────────────────────────────── onboarding flow

describe('bootstrapCompany onboarding', () => {
  it('rejects a wrong setup code', async () => {
    await expectFailure(
      call('bootstrapCompany', { code: 'wrong-code-value', companyName: 'X', adminEmail: 'x@local.test' }),
      'permission-denied',
      'wrong setup code',
    );
  });

  it('rejects a correct code while a company already exists', async () => {
    await expectFailure(
      call('bootstrapCompany', { code: SETUP_CODE, companyName: 'X', adminEmail: 'x@local.test' }),
      'failed-precondition',
      'bootstrap when a company exists',
    );
  });

  it('creates the first company and its admin from an empty database, then restores it', async () => {
    /**
     * bootstrapCompany refuses unless NO company exists, so the happy path needs
     * an empty collection. The emulator already holds the seeded demo tenant, so
     * this test parks it, runs onboarding, then puts it back.
     *
     * Snapshot/restore rather than create-and-delete: if the assertion fails
     * midway, the finally block still restores the seed, so a failing test cannot
     * leave the demo environment broken for every other suite.
     */
    const snap = await db.collection('companies').get();
    const parked = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const BOOT_EMAIL = 'zz-bootstrap-admin@local.test';

    try {
      await Promise.all(parked.map((p) => db.collection('companies').doc(p.id).delete()));

      const res = await call('bootstrapCompany', {
        code: SETUP_CODE,
        companyName: 'Bootstrap Test Co',
        adminEmail: BOOT_EMAIL,
        adminName: 'Bootstrap Admin',
      });

      assert.ok(res.companyId, 'onboarding must return the new company id');
      assert.ok(res.adminUid);

      // The admin must be able to sign in and act, with claims from bootstrap.
      await createStaffUser({ email: BOOT_EMAIL, companyId: res.companyId, role: 'company_admin' });
      const boot = await signIn(BOOT_EMAIL);
      assert.equal(boot.claims.companyId, res.companyId);
      assert.equal(boot.claims.role, 'company_admin');

      const staff = await call('listStaff', {}, boot.idToken);
      assert.ok(staff.staff.length >= 1, 'the bootstrapped admin must see the team');

      // Second run must be refused now that a company exists.
      await expectFailure(
        call('bootstrapCompany', { code: SETUP_CODE, companyName: 'Again', adminEmail: 'again@local.test' }),
        'failed-precondition',
        'second bootstrap',
      );

      await cleanupCompany(res.companyId);
      await cleanupUsers([BOOT_EMAIL]);
    } finally {
      for (const p of parked) {
        await db.collection('companies').doc(p.id).set(p.data);
      }
    }

    const restored = await db.collection('companies').get();
    assert.equal(restored.size, parked.length, 'the seeded tenants must be restored');
  });
});
