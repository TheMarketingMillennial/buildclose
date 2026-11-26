/**
 * Phase 2 integration verification — subscription entitlement enforcement.
 *
 * The pure rules are proven in `entitlements.test.mjs` (40 tests, no emulator).
 * This suite proves the part that unit tests cannot: that the rules are actually
 * WIRED INTO the write paths, and that a real callable call is really refused.
 *
 * What it defends, in order of consequence:
 *
 *   1. A company on a plan with one active proposal is allowed exactly one, and
 *      the second is refused with `resource-exhausted` — not silently created.
 *   2. Archiving a proposal frees the slot, so the limit is a live count rather
 *      than a cumulative tally that punishes archiving.
 *   3. A seat limit is enforced BEFORE a Firebase Auth user is created, so a
 *      refused invite leaves no orphaned account behind.
 *   4. A pilot override restores access, and an EXPIRED one does not — the grant
 *      is re-evaluated at read time, not trusted because it exists.
 *   5. A tenant with no subscription at all stays unlimited (grandfathered). This
 *      is the property that keeps every existing customer working.
 *   6. Only a platform_admin may define a plan. A company_admin is refused, which
 *      is what stops a tenant granting itself a bigger plan.
 *
 * Run:  node --test tests/entitlements.verify.test.mjs
 * Needs: emulator (auth, firestore, functions) running. No OpenAI stub required.
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

// Prefix distinct from every other suite so parallel/running order cannot overlap.
const TENANT = 'p2-tenant-plan';
const TENANT_LEGACY = 'p2-tenant-legacy';
const PLATFORM_TENANT = 'p2-platform-ops';

const EMAILS = {
  admin: 'p2-admin@buildclose.test',
  secondSeat: 'p2-seat-two@buildclose.test',
  legacyAdmin: 'p2-legacy-admin@buildclose.test',
  operator: 'p2-operator@buildclose.test',
};

const PLAN_ID = 'p2-starter';
const ctx = {};

function planPayload(overrides = {}) {
  return {
    id: PLAN_ID,
    name: 'P2 Starter',
    description: 'One seat, one active proposal — the tightest plan the tests can build.',
    stripePriceIds: ['price_p2_starter'],
    limits: {
      maxUsers: 1,
      maxActiveProposals: 1,
      maxDocumentStorageMb: 10,
      aiMonthlyBudgetUsd: 5,
    },
    features: {
      documentIntelligence: false,
      companyIntelligence: true,
      customBranding: false,
      advancedAnalytics: false,
    },
    priceNote: 'Contact sales',
    gracePeriodDays: 7,
    active: true,
    sortOrder: 1,
    ...overrides,
  };
}

before(async () => {
  // A company that owns a paid plan.
  await db.collection('companies').doc(TENANT).set(
    { name: 'P2 Plan Co', settings: { retentionDays: 365, aiBudgetUsd: 25 } },
    { merge: true },
  );
  // A company that predates billing entirely: no subscription, no override.
  await db.collection('companies').doc(TENANT_LEGACY).set(
    { name: 'P2 Legacy Co', settings: { retentionDays: 365, aiBudgetUsd: 25 } },
    { merge: true },
  );

  // platform_admin may belong to no real tenant; the role is what authorises.
  await db.collection('companies').doc(PLATFORM_TENANT).set({ name: 'P2 Platform' }, { merge: true });

  ctx.adminUid = await createStaffUser({ email: EMAILS.admin, companyId: TENANT, role: 'company_admin' });
  ctx.legacyUid = await createStaffUser({ email: EMAILS.legacyAdmin, companyId: TENANT_LEGACY, role: 'company_admin' });
  await createStaffUser({ email: EMAILS.operator, companyId: PLATFORM_TENANT, role: 'platform_admin' });

  ctx.admin = (await signIn(EMAILS.admin)).idToken;
  ctx.legacyAdmin = (await signIn(EMAILS.legacyAdmin)).idToken;
  ctx.operator = (await signIn(EMAILS.operator)).idToken;

  // Define the plan through the real callable, so the operator path is exercised.
  // Remove any plan left by a previous run first: the suite must be rerunnable,
  // and createPlan correctly refuses a duplicate id.
  await db.collection('plans').doc(PLAN_ID).delete().catch(() => undefined);
  await call('createPlan', planPayload(), ctx.operator);
});

after(async () => {
  await cleanupCompany(TENANT);
  await cleanupCompany(TENANT_LEGACY);
  await cleanupCompany(PLATFORM_TENANT);
  await cleanupUsers(Object.values(EMAILS));

  // Plans are company-wide, so they are not removed by cleanupCompany.
  await db.collection('plans').doc(PLAN_ID).delete().catch(() => undefined);
  await db.collection('entitlementOverrides').doc(TENANT).delete().catch(() => undefined);
  await db.collection('entitlementOverrides').doc(TENANT_LEGACY).delete().catch(() => undefined);
  await db.collection('subscriptions').doc(TENANT).delete().catch(() => undefined);
  await db.collection('subscriptions').doc(TENANT_LEGACY).delete().catch(() => undefined);
});

/** Put the tenant on a healthy subscription for the starter plan. */
async function activateSubscription(overrides = {}) {
  await db.collection('subscriptions').doc(TENANT).set(
    {
      companyId: TENANT,
      status: 'active',
      planId: PLAN_ID,
      priceId: 'price_p2_starter',
      stripeCustomerId: 'cus_p2',
      stripeSubscriptionId: 'sub_p2',
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      cancelAtPeriodEnd: false,
      ...overrides,
    },
    { merge: true },
  );
}

test('a plan can only be defined by a platform administrator', async () => {
  // The tenant admin is refused outright — this is what stops a customer from
  // minting themselves an unlimited plan.
  await expectFailure(
    call('createPlan', planPayload({ id: 'p2-forbidden' }), ctx.admin),
    'permission-denied',
    'company_admin creating a plan',
  );
});

test('the entitlement callable reports the plan, usage and a stable state', async () => {
  await activateSubscription();

  const ent = await call('getCompanyEntitlements', {}, ctx.admin);

  assert.equal(ent.state, 'active');
  assert.equal(ent.planId, PLAN_ID);
  assert.equal(ent.canGrow, true);
  assert.equal(ent.grandfathered, false);
  assert.equal(ent.limits.maxActiveProposals, 1);
  // The admin user itself occupies the single seat.
  assert.equal(ent.usage.users, 1);
  assert.equal(ent.usage.activeProposals, 0);
  assert.equal(ent.canManageBilling, true);
});

/**
 * Remove every proposal a test tenant owns.
 *
 * Several tests below assert on the ACTIVE proposal count, so leftover proposals
 * from an earlier test would make a later one fail for the previous test's reason.
 * Clearing between them keeps each assertion about its own subject.
 */
async function clearProposals() {
  for (const name of ['proposals', 'proposalInternal', 'agentConfigs', 'accessTokens']) {
    const snap = await db.collection(name).where('companyId', '==', TENANT).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

test('the active-proposal limit blocks the second proposal with resource-exhausted', async () => {
  await activateSubscription();
  await clearProposals();

  const first = await call('createProposal', { proposal: proposalPayload({ title: 'P2 First' }) }, ctx.admin);
  assert.ok(first.id, 'the first proposal fits inside the plan');

  // Second is refused. If this ever passes, the plan limit is decorative.
  await expectFailure(
    call('createProposal', { proposal: proposalPayload({ title: 'P2 Second' }) }, ctx.admin),
    'resource-exhausted',
    'second proposal over the limit',
  );

  // Archiving frees the slot, proving the limit is a live count and not a
  // cumulative tally.
  await call('archiveProposal', { id: first.id }, ctx.admin);
  const third = await call('createProposal', { proposal: proposalPayload({ title: 'P2 Third' }) }, ctx.admin);
  assert.ok(third.id, 'archiving must free the slot');

  // Duplicating is a second creation path and must be subject to the same limit.
  await expectFailure(
    call('duplicateProposal', { id: third.id }, ctx.admin),
    'resource-exhausted',
    'duplicate over the limit',
  );
});

test('a refused invite creates no orphaned Auth user', async () => {
  await activateSubscription();

  const auth = (await import('firebase-admin/auth')).getAuth();

  // The single seat is already taken by the admin.
  await expectFailure(
    call('inviteStaff', { email: EMAILS.secondSeat, role: 'sales_rep' }, ctx.admin),
    'resource-exhausted',
    'invite over the seat limit',
  );

  // The proof that the guard runs BEFORE account creation: there is no user.
  await assert.rejects(
    () => auth.getUserByEmail(EMAILS.secondSeat),
    'a refused invite must not leave a Firebase Auth account behind',
  );
});

test('a lapsed subscription blocks growth but keeps the entitlement readable', async () => {
  // Canceled and past its period: restricted.
  await db.collection('subscriptions').doc(TENANT).set(
    {
      companyId: TENANT,
      status: 'canceled',
      planId: PLAN_ID,
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
      cancelAtPeriodEnd: false,
    },
    { merge: true },
  );

  const ent = await call('getCompanyEntitlements', {}, ctx.admin);
  assert.equal(ent.state, 'restricted');
  assert.equal(ent.canGrow, false);

  await expectFailure(
    call('createProposal', { proposal: proposalPayload({ title: 'P2 Blocked' }) }, ctx.admin),
    'failed-precondition',
    'proposal on a lapsed subscription',
  );
});

test('a past_due subscription inside its grace window keeps full access', async () => {
  await db.collection('subscriptions').doc(TENANT).set(
    {
      companyId: TENANT,
      status: 'past_due',
      planId: PLAN_ID,
      // Three days ago, with a 7-day grace period on the plan.
      currentPeriodEnd: new Date(Date.now() - 3 * 86_400_000),
      cancelAtPeriodEnd: false,
    },
    { merge: true },
  );

  const ent = await call('getCompanyEntitlements', {}, ctx.admin);
  assert.equal(ent.state, 'grace');
  assert.equal(ent.canGrow, true, 'grace must not block work');
  assert.equal(ent.graceDaysRemaining, 4);
});

test('a pilot override restores access, and expiring it removes it again', async () => {
  // Start from a lapsed subscription.
  await db.collection('subscriptions').doc(TENANT).set(
    {
      companyId: TENANT,
      status: 'canceled',
      planId: PLAN_ID,
      currentPeriodEnd: new Date(Date.now() - 5 * 86_400_000),
    },
    { merge: true },
  );

  await expectFailure(
    call('createProposal', { proposal: proposalPayload({ title: 'P2 Pre-pilot' }) }, ctx.admin),
    'failed-precondition',
    'before the pilot grant',
  );

  // Grant a pilot with a wider proposal allowance.
  const expiry = new Date(Date.now() + 14 * 86_400_000).toISOString();
  await call(
    'setEntitlementOverride',
    { companyId: TENANT, planId: PLAN_ID, limits: { maxActiveProposals: 5 }, expiresAt: expiry, note: 'P2 pilot' },
    ctx.operator,
  );

  const piloted = await call('getCompanyEntitlements', {}, ctx.admin);
  assert.equal(piloted.state, 'pilot');
  assert.equal(piloted.canGrow, true);
  assert.equal(piloted.limits.maxActiveProposals, 5, 'the override limit applies');

  const created = await call('createProposal', { proposal: proposalPayload({ title: 'P2 Pilot OK' }) }, ctx.admin);
  assert.ok(created.id, 'a pilot grant must restore proposal creation');

  // An override must not be creatable without an expiry.
  await expectFailure(
    call('setEntitlementOverride', { companyId: TENANT, limits: { maxUsers: 99 } }, ctx.operator),
    'invalid-argument',
    'override without an expiry',
  );

  // Expire it in place: the resolver must stop honouring it by itself.
  await db.collection('entitlementOverrides').doc(TENANT).set(
    { expiresAt: new Date(Date.now() - 60_000), enabled: true, planId: PLAN_ID, limits: { maxActiveProposals: 5 } },
    { merge: true },
  );

  const lapsed = await call('getCompanyEntitlements', {}, ctx.admin);
  assert.equal(lapsed.state, 'restricted', 'an expired grant must not still apply');
  assert.equal(lapsed.canGrow, false);
});

test('clearing a pilot override returns the company to its subscription state', async () => {
  await call('setEntitlementOverride', {
    companyId: TENANT,
    planId: PLAN_ID,
    limits: { maxActiveProposals: 5 },
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }, ctx.operator);

  assert.equal((await call('getCompanyEntitlements', {}, ctx.admin)).state, 'pilot');

  await call('clearEntitlementOverride', { companyId: TENANT }, ctx.operator);

  // Still lapsed underneath, so clearing the grant restricts again.
  assert.equal((await call('getCompanyEntitlements', {}, ctx.admin)).state, 'restricted');
});

test('a tenant with no subscription is grandfathered and unlimited', async () => {
  const ent = await call('getCompanyEntitlements', {}, ctx.legacyAdmin);

  assert.equal(ent.state, 'unsubscribed');
  assert.equal(ent.grandfathered, true);
  assert.equal(ent.canGrow, true);
  assert.equal(ent.limits.maxActiveProposals, null);

  // Two proposals in a row, which the starter plan would have refused.
  const a = await call('createProposal', { proposal: proposalPayload({ title: 'P2 Legacy A' }) }, ctx.legacyAdmin);
  const b = await call('createProposal', { proposal: proposalPayload({ title: 'P2 Legacy B' }) }, ctx.legacyAdmin);
  assert.ok(a.id && b.id, 'grandfathered tenants are not limited');
});

test('entitlement blocks are recorded in the audit trail', async () => {
  await activateSubscription();
  // Start from a known-empty slate: earlier tests left proposals behind, and this
  // test needs its FIRST create to succeed so that the SECOND is the one blocked.
  await clearProposals();
  await call('createProposal', { proposal: proposalPayload({ title: 'P2 Audit Fill' }) }, ctx.admin);
  await expectFailure(
    call('createProposal', { proposal: proposalPayload({ title: 'P2 Audit Blocked' }) }, ctx.admin),
    'resource-exhausted',
    'audited block',
  );

  const auditSnap = await db
    .collection('auditLog')
    .where('companyId', '==', TENANT)
    .where('action', '==', 'entitlement.blocked')
    .limit(10)
    .get();

  assert.ok(auditSnap.size > 0, 'a blocked action must leave a trail');
  const detail = auditSnap.docs[0].data().detail ?? {};
  assert.equal(detail.attempted, 'proposal.create');
  assert.equal(detail.code, 'plan_limit_reached');
});
