/**
 * Phase 1 integration verification — staff callables only.
 *
 * Deliberately excludes anything that reaches OpenAI. Every assertion here runs
 * through real callables, real custom claims, real Firestore and the real
 * authorization path, so it proves the Phase 1 wiring without needing the stub
 * on port 8787. The prospect/chat path (where company knowledge is merged into a
 * live prompt) is verified separately, because it cannot run without the stub.
 *
 * What this file is actually defending:
 *
 *   1. Configuration is retrievable and a partial save does not blank the rest.
 *   2. A proposal created after configuration inherits it — and two proposals
 *      created the same way both do, so inheritance is not a one-off.
 *   3. Company authority changes reach proposals that ALREADY exist, because
 *      effective authority is recomputed per read rather than copied on write.
 *   4. A proposal may tighten authority but never loosen it, on write.
 *   5. A loosened record that bypassed the write path (migration, console edit)
 *      still cannot loosen authority at read time. This is the second of the two
 *      enforcement points and the reason the first one is not sufficient.
 *   6. A representative never receives internal pricing, and a tenant cannot read
 *      another tenant's proposal even with a valid token.
 *   7. The seeded Abrica proposal — which has no company intelligence or company
 *      authority record at all — still resolves authority from its own internals.
 *      That is the backward-compatibility case: every existing customer looks
 *      exactly like this.
 *
 * Run:  node --test tests/company.verify.test.mjs
 * Needs: emulator (auth, firestore, functions) running.
 */
import test, { before, after } from 'node:test';
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
} from './support/staff-fixture.mjs';

// Distinct from integration.test.mjs's tenant ids so the two suites cannot
// interfere if they ever run in the same emulator instance.
const TENANT_A = 'p1-tenant-a';
const TENANT_B = 'p1-tenant-b';
const ABRICA = 'abrica-demo';

const EMAILS = {
  adminA: 'p1-admin-a@buildclose.test',
  managerA: 'p1-manager-a@buildclose.test',
  repA: 'p1-rep-a@buildclose.test',
  adminB: 'p1-admin-b@buildclose.test',
  abricaAdmin: 'p1-admin-abrica@buildclose.test',
};

const ctx = {};

/** A complete, valid commercial authority record. Never partial — the callable replaces whole. */
function authority(overrides = {}) {
  return {
    priceFloorMinor: 1_500_000, // $15,000
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
    quotableAmountsMinor: [75_000],
    negotiationBoundaries: ['Do not waive the setup fee.'],
    internalNotes: 'Floor is confidential and must never reach a prospect.',
    ...overrides,
  };
}

before(async () => {
  // Companies exist first: the callables read settings from the company doc.
  for (const [id, name] of [
    [TENANT_A, 'Tenant A Ltd'],
    [TENANT_B, 'Tenant B Ltd'],
  ]) {
    await db.collection('companies').doc(id).set({ name, settings: { retentionDays: 365 } }, { merge: true });
  }
  await db.collection('companies').doc(ABRICA).set({ name: 'The Marketing Millennial' }, { merge: true });

  await createStaffUser({ email: EMAILS.adminA, companyId: TENANT_A, role: 'company_admin' });
  await createStaffUser({ email: EMAILS.managerA, companyId: TENANT_A, role: 'sales_manager' });
  await createStaffUser({ email: EMAILS.repA, companyId: TENANT_A, role: 'sales_rep' });
  await createStaffUser({ email: EMAILS.adminB, companyId: TENANT_B, role: 'company_admin' });
  // Read-only cross-check against the seeded tenant. Nothing in abrica-demo is
  // written except this user record, which is removed in after().
  await createStaffUser({ email: EMAILS.abricaAdmin, companyId: ABRICA, role: 'company_admin' });

  ctx.adminA = (await signIn(EMAILS.adminA)).idToken;
  ctx.managerA = (await signIn(EMAILS.managerA)).idToken;
  ctx.repA = (await signIn(EMAILS.repA)).idToken;
  ctx.adminB = (await signIn(EMAILS.adminB)).idToken;
  ctx.abricaAdmin = (await signIn(EMAILS.abricaAdmin)).idToken;
});

after(async () => {
  await cleanupCompany(TENANT_A);
  await cleanupCompany(TENANT_B);
  // Abrica is a client tenant: remove only the fixture user, never its proposal.
  const abricaUser = await db.collection('users').where('companyId', '==', ABRICA).get();
  await Promise.all(abricaUser.docs.map((d) => d.ref.delete()));
  await cleanupUsers(Object.values(EMAILS));
});

// ─────────────────────────────────────────── configuration: save and retrieve

test('company intelligence saves a section and reads it back', async () => {
  const res = await call(
    'updateCompanyIntelligence',
    {
      profile: {
        displayName: 'Tenant A',
        description: 'We build intake systems for litigation firms.',
        differentiators: ['Own the infrastructure', 'Four checkpoint releases'],
      },
    },
    ctx.adminA,
  );
  assert.deepEqual(res.sections, ['profile']);

  const read = await call('getCompanyIntelligence', {}, ctx.managerA);
  assert.equal(read.configured, true);
  assert.equal(read.canEdit, true);
  assert.equal(read.intelligence.profile.displayName, 'Tenant A');
  assert.equal(read.intelligence.profile.differentiators.length, 2);
});

test('a second partial save does not blank the first section', async () => {
  // The bug this guards: parsing a partial patch with nested `.default({})`
  // materialises empty defaults and overwrites stored values, silently destroying
  // the profile a manager already saved.
  await call(
    'updateCompanyIntelligence',
    { faqs: [{ question: 'Do you offer support?', answer: 'Yes, in writing.' }] },
    ctx.adminA,
  );

  const read = await call('getCompanyIntelligence', {}, ctx.adminA);
  assert.equal(read.intelligence.profile.displayName, 'Tenant A', 'profile was blanked by a faqs-only save');
  assert.equal(read.intelligence.profile.differentiators.length, 2);
  assert.equal(read.intelligence.faqs.length, 1);
});

test('assistant defaults are stored for inheritance', async () => {
  await call(
    'updateCompanyIntelligence',
    {
      assistantDefaults: {
        displayName: 'Acme Deal Assistant',
        welcomeMessage: 'Welcome — I can walk you through this proposal.',
        persona: 'Direct and unhurried.',
      },
    },
    ctx.adminA,
  );
  const read = await call('getCompanyIntelligence', {}, ctx.adminA);
  assert.equal(read.intelligence.assistantDefaults.displayName, 'Acme Deal Assistant');
});

test('an unknown section is rejected rather than silently dropped', async () => {
  const err = await expectFailure(
    call('updateCompanyIntelligence', { profiles: { displayName: 'typo' } }, ctx.adminA),
    'invalid-argument',
    'unknown section',
  );
  assert.match(err.message, /Unknown section/i);
});

test('an empty patch is rejected', async () => {
  await expectFailure(
    call('updateCompanyIntelligence', {}, ctx.adminA),
    'invalid-argument',
    'empty patch',
  );
});

test('a representative may read intelligence but not write it', async () => {
  const read = await call('getCompanyIntelligence', {}, ctx.repA);
  assert.equal(read.configured, true);
  assert.equal(read.canEdit, false, 'a rep must not be offered edit affordances');

  await expectFailure(
    call('updateCompanyIntelligence', { profile: { displayName: 'hijacked' } }, ctx.repA),
    'permission-denied',
    'rep write',
  );
});

// ─────────────────────────────────────────── inheritance across proposals

test('two proposals created after configuration both inherit assistant defaults', async () => {
  const first = await call('createProposal', { proposal: proposalPayload({ title: 'First Inherit' }) }, ctx.adminA);
  const second = await call('createProposal', { proposal: proposalPayload({ title: 'Second Inherit' }) }, ctx.adminA);
  ctx.inheritIds = [first.id, second.id];

  for (const id of [first.id, second.id]) {
    const read = await call('getProposal', { id }, ctx.adminA);
    assert.equal(
      read.agent.displayName,
      'Acme Deal Assistant',
      `proposal ${id} did not inherit the company assistant display name`,
    );
  }
});

test("a proposal's own agent config wins over the inherited default", async () => {
  const created = await call(
    'createProposal',
    {
      proposal: proposalPayload({ title: 'Own Voice' }),
      agent: { displayName: 'Bespoke Assistant' },
    },
    ctx.adminA,
  );
  const read = await call('getProposal', { id: created.id }, ctx.adminA);
  assert.equal(read.agent.displayName, 'Bespoke Assistant');
});

// ─────────────────────────────────────────── authority: write and read

test('company authority is written whole and read back to a manager', async () => {
  const res = await call('updateCompanyAuthority', { authority: authority() }, ctx.adminA);
  assert.equal(res.ok, true);

  const read = await call('getCompanyAuthority', {}, ctx.managerA);
  assert.equal(read.configured, true);
  assert.equal(read.authority.maxDiscountPercent, 15);
  assert.equal(read.authority.priceFloorMinor, 1_500_000);
});

test('a payment schedule that does not total 100% is refused', async () => {
  const err = await expectFailure(
    call(
      'updateCompanyAuthority',
      {
        authority: authority({
          paymentSchedule: [
            { label: 'Commencement', percent: 40 },
            { label: 'Delivery', percent: 50 },
          ],
        }),
      },
      ctx.adminA,
    ),
    'invalid-argument',
    'payment schedule',
  );
  assert.match(err.message, /100%/);
});

test('a representative is refused authority outright, not shown a redacted record', async () => {
  await expectFailure(call('getCompanyAuthority', {}, ctx.repA), 'permission-denied', 'rep read authority');
  await expectFailure(
    call('updateCompanyAuthority', { authority: authority({ maxDiscountPercent: 90 }) }, ctx.repA),
    'permission-denied',
    'rep write authority',
  );
});

// ─────────────────────────────────────────── authority reaches EXISTING proposals

test('a proposal created with no internals reports the company ceiling, not zero', async () => {
  // The regression this exists for: ProposalInternalInput defaults
  // maxDiscountPercent to 0. If a read treated that default as intent, the
  // tighter-of-two rule would resolve to 0% for every proposal and silently
  // disable all commerce.
  const created = await call('createProposal', { proposal: proposalPayload({ title: 'No Internals' }) }, ctx.adminA);
  ctx.noInternalId = created.id;

  const read = await call('getProposal', { id: created.id }, ctx.adminA);
  assert.equal(read.effectiveAuthority.maxDiscountPercent, 15, 'company ceiling was clamped to the 0 default');
  assert.equal(read.effectiveAuthority.priceFloorMinor, 1_500_000);
  assert.deepEqual(read.effectiveAuthority.tightened, []);
});

test('changing company authority changes an existing proposal on the next read', async () => {
  await call('updateCompanyAuthority', { authority: authority({ maxDiscountPercent: 8 }) }, ctx.adminA);

  const read = await call('getProposal', { id: ctx.noInternalId }, ctx.adminA);
  assert.equal(read.effectiveAuthority.maxDiscountPercent, 8, 'existing proposal did not follow the company change');

  // Restore for later assertions in this file.
  await call('updateCompanyAuthority', { authority: authority() }, ctx.adminA);
});

// ─────────────────────────────────────────── override: tighten, never loosen

test('a proposal may tighten the discount ceiling', async () => {
  await call('updateProposal', { id: ctx.noInternalId, internal: { maxDiscountPercent: 5 } }, ctx.adminA);
  const read = await call('getProposal', { id: ctx.noInternalId }, ctx.adminA);
  assert.equal(read.effectiveAuthority.maxDiscountPercent, 5);
});

test('a proposal may not raise the ceiling above the company limit', async () => {
  const err = await expectFailure(
    call('updateProposal', { id: ctx.noInternalId, internal: { maxDiscountPercent: 40 } }, ctx.adminA),
    'permission-denied',
    'raise ceiling',
  );
  assert.match(err.message, /stricter/i);
});

test('a proposal may not drop the price floor below the company floor', async () => {
  await expectFailure(
    call('updateProposal', { id: ctx.noInternalId, internal: { priceFloorMinor: 100_000 } }, ctx.adminA),
    'permission-denied',
    'lower floor',
  );
});

test('a loosened record written outside the governed path is still clamped on read', async () => {
  // Worst case, and the reason the write-time gate is not sufficient: someone
  // writes a LOOSER value straight into the override channel that
  // effectiveAuthority() actually reads — a migration, a console edit, or any
  // future code path. updateProposal never saw it, so only the read-time clamp
  // can hold the company floor.
  await db
    .collection('proposalInternal')
    .doc(ctx.noInternalId)
    .set(
      {
        companyId: TENANT_A,
        priceFloorMinor: 50_000,
        maxDiscountPercent: 60,
        authorityOverrides: { priceFloorMinor: 50_000, maxDiscountPercent: 60 },
      },
      { merge: true },
    );

  const read = await call('getProposal', { id: ctx.noInternalId }, ctx.adminA);

  assert.equal(
    read.internal.authorityOverrides.maxDiscountPercent,
    60,
    'the stored override should still be visible to a manager, so they can see what was requested',
  );
  assert.equal(read.effectiveAuthority.maxDiscountPercent, 15, 'read-time clamp did not hold the company ceiling');
  assert.equal(read.effectiveAuthority.priceFloorMinor, 1_500_000, 'read-time clamp did not hold the company floor');
  assert.ok(
    read.effectiveAuthority.tightened.includes('maxDiscountPercent'),
    'the manager must be told which field company policy overrode',
  );
  assert.ok(
    read.effectiveAuthority.tightened.includes('priceFloorMinor'),
    'the overridden floor must also be reported',
  );
});

// ─────────────────────────────────────────── no internal disclosure to reps

test('a representative reading their own proposal gets no internals and no authority', async () => {
  const created = await call('createProposal', { proposal: proposalPayload({ title: 'Rep Owned' }) }, ctx.repA);
  const read = await call('getProposal', { id: created.id }, ctx.repA);

  assert.equal(read.internal, null, 'rep received the internal record');
  assert.equal(read.effectiveAuthority, null, 'rep received effective authority');
  assert.equal(read.canEditInternal, false);
});

test("one rep cannot read another rep's proposal", async () => {
  const created = await call('createProposal', { proposal: proposalPayload({ title: 'Admin Owned' }) }, ctx.adminA);
  await expectFailure(call('getProposal', { id: created.id }, ctx.repA), 'permission-denied', 'foreign owned proposal');
});

// ─────────────────────────────────────────── tenant isolation

test("a tenant cannot read another tenant's proposal", async () => {
  // Reported as not-found rather than forbidden so tenants cannot probe for ids.
  await expectFailure(call('getProposal', { id: ctx.noInternalId }, ctx.adminB), 'not-found', 'cross-tenant read');
});

test("a tenant cannot edit another tenant's proposal", async () => {
  await expectFailure(
    call('updateProposal', { id: ctx.noInternalId, proposal: { title: 'hijacked' } }, ctx.adminB),
    'not-found',
    'cross-tenant write',
  );
});

test('company intelligence is not shared across tenants', async () => {
  const read = await call('getCompanyIntelligence', {}, ctx.adminB);
  assert.equal(read.configured, false, 'tenant B saw tenant A intelligence');
  assert.equal(read.intelligence.profile.displayName, '');
});

// ─────────────────────────────────────────── Abrica backward compatibility

test('the seeded Abrica proposal still resolves authority from its own internals', async () => {
  // Abrica has no companyAuthority and no companyIntelligence document: it is
  // exactly what every existing customer looks like before they configure
  // anything. Its authority must come from the proposal's own internal record.
  const read = await call('getProposal', { id: 'abrica-stage-one' }, ctx.abricaAdmin);

  assert.equal(read.proposal.companyId, ABRICA);
  assert.ok(read.internal, 'seeded internal record missing — run seed/run.mjs');
  assert.equal(read.internal.priceFloorMinor, 2_400_000, 'Abrica floor changed');
  assert.equal(read.internal.maxDiscountPercent, 0, 'Abrica ceiling changed');

  assert.equal(read.effectiveAuthority.priceFloorMinor, 2_400_000);
  assert.equal(read.effectiveAuthority.maxDiscountPercent, 0);
  assert.equal(
    read.effectiveAuthority.negotiable.canOfferDiscounts,
    false,
    'Abrica pricing is fixed; the assistant must not be able to offer a discount',
  );
});

test('the Abrica proposal is untouched by this suite', async () => {
  // Guards the instruction that Abrica remains an independent client.
  const snap = await db.collection('proposals').doc('abrica-stage-one').get();
  assert.equal(snap.data().companyId, ABRICA);
  assert.equal(snap.data().totalValueMinor, 2_400_000);
  assert.equal(snap.data().documentVersion, 1);

  const intel = await db.collection('companyIntelligence').doc(ABRICA).get();
  assert.equal(intel.exists, false, 'this suite created company intelligence for Abrica');
});
