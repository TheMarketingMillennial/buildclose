/**
 * Phase 2 integration verification — subscription entitlement enforcement.
 *
 * The pure rules are proven in `entitlements.test.mjs` (no emulator). This suite
 * proves the part unit tests cannot: that the rules are actually WIRED INTO the
 * write paths, and that a real callable call is really refused.
 *
 * What it defends, in order of consequence:
 *
 *   1. DENY BY DEFAULT. A company with no subscription and no grant is
 *      `unentitled`: zero seats, zero proposals, zero model spend. The absence of
 *      a subscription record is never read as permission. (An earlier draft
 *      treated this as "grandfathered, unlimited"; that is the behaviour this
 *      suite exists to prevent from coming back.)
 *   2. An EXPLICIT internal grant restores access, and clearing it removes access
 *      again. This is how Abrica and the development tenants legitimately keep
 *      working: a deliberate, auditable, per-tenant decision — not an emergent
 *      default.
 *   3. A company on a plan with one active proposal is allowed exactly one, and
 *      the second is refused with `resource-exhausted` — not silently created.
 *   4. Archiving a proposal frees the slot, so the limit is a live count rather
 *      than a cumulative tally that punishes archiving.
 *   5. A seat limit is enforced BEFORE a Firebase Auth user is created, so a
 *      refused invite leaves no orphaned account behind.
 *   6. A pilot grant restores access, and an EXPIRED one does not — the grant is
 *      re-evaluated at read time, not trusted because it exists.
 *   7. A lapsed subscription blocks growth but keeps a SMALL AI allowance: a
 *      little, not none and not unlimited.
 *   8. Only a platform_admin may define a plan. A company_admin is refused, which
 *      is what stops a tenant granting itself a bigger plan.
 *
 * Fixture policy (see tests/support/staff-fixture.mjs):
 *   - `TENANT` is subscription-driven and carries NO internal grant, so the plan
 *     limits are the only thing that can allow or deny.
 *   - `TENANT_LEGACY` deliberately receives NO grant until the test that proves
 *     grants work, because it is the fixture for unentitled access.
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
  grantInternal,
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

/**
 * Remove every proposal a test tenant owns, AND reset the usage counter.
 *
 * Several tests below assert on the ACTIVE proposal count, so leftover proposals
 * from an earlier test would make a later one fail for the previous test's reason.
 *
 * The counter reset matters just as much: reservations are counted in a
 * `usageCounters/{companyId}` document that seeds itself from the live row count
 * exactly once. Deleting the proposal rows without dropping the counter would
 * leave the counter asserting "1 of 1 used" against an empty collection, and the
 * next legitimate create would be refused — a failure that looks like an
 * enforcement bug but is really fixture drift. Dropping the document makes the
 * next reservation re-seed from the live count, which is the same thing a cold
 * start does in production.
 */
async function clearProposals(companyId = TENANT) {
  for (const name of ['proposals', 'proposalInternal', 'agentConfigs', 'accessTokens']) {
    const snap = await db.collection(name).where('companyId', '==', companyId).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection('usageCounters').doc(companyId).delete().catch(() => undefined);
}

before(async () => {
  // A company that owns a paid plan. No grant: plan limits are the only authority.
  await db.collection('companies').doc(TENANT).set(
    { name: 'P2 Plan Co', settings: { retentionDays: 365, aiBudgetUsd: 25 } },
    { merge: true },
  );
  // A company that predates billing entirely: no subscription, no override. This
  // is the unentitled fixture and must stay that way.
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

  // A rerun must start from a known slate: no stale proposals, no stale counters,
  // and no grant left on the tenant that is supposed to have none.
  await clearProposals();
  await db.collection('entitlementOverrides').doc(TENANT_LEGACY).delete().catch(() => undefined);

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
  await clearProposals();

  const ent = await call('getCompanyEntitlements', {}, ctx.admin);

  assert.equal(ent.state, 'active');
  assert.equal(ent.planId, PLAN_ID);
  assert.equal(ent.canGrow, true);
  assert.equal(ent.needsPlan, false, 'a subscribed company is not pending a plan');
  assert.equal(ent.grantKind, null, 'a subscription is not an administrative grant');
  assert.equal(ent.limits.maxActiveProposals, 1);
  // The admin user itself occupies the single seat.
  assert.equal(ent.usage.users, 1);
  assert.equal(ent.usage.activeProposals, 0);
  assert.equal(ent.canManageBilling, true);
});

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

test('a lapsed subscription blocks growth but keeps a small AI allowance', async () => {
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

  // A little, not none and not unlimited: the lapsed floor applies, and it is
  // tighter than the plan's own $5 cap so lapsed access can never be more
  // generous than paying.
  assert.equal(ent.limits.aiMonthlyBudgetUsd, 2, 'a lapsed account keeps a small, capped allowance');
  assert.equal(ent.limits.maxActiveProposals, 0, 'but no growth');

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

test('a pilot grant restores access, and expiring it removes it again', async () => {
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
  assert.equal(piloted.state, 'granted');
  assert.equal(piloted.grantKind, 'pilot', 'a time-boxed grant is a pilot');
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

  assert.equal((await call('getCompanyEntitlements', {}, ctx.admin)).state, 'granted');

  await call('clearEntitlementOverride', { companyId: TENANT }, ctx.operator);

  // Still lapsed underneath, so clearing the grant restricts again.
  assert.equal((await call('getCompanyEntitlements', {}, ctx.admin)).state, 'restricted');
});

test('a tenant with no subscription and no grant is denied, not grandfathered', async () => {
  // Make the precondition explicit rather than assuming it: no subscription, no
  // override. If a previous test leaked a grant, this fails loudly here.
  await db.collection('subscriptions').doc(TENANT_LEGACY).delete().catch(() => undefined);
  await db.collection('entitlementOverrides').doc(TENANT_LEGACY).delete().catch(() => undefined);
  await clearProposals(TENANT_LEGACY);

  const ent = await call('getCompanyEntitlements', {}, ctx.legacyAdmin);

  assert.equal(ent.state, 'unentitled', 'absence of a subscription is not permission');
  assert.equal(ent.needsPlan, true, 'the dashboard must be told a plan is needed');
  assert.equal(ent.canGrow, false);
  assert.equal(ent.limits.maxActiveProposals, 0, 'no proposals');
  assert.equal(ent.limits.maxUsers, 0, 'no seats');
  assert.equal(ent.limits.aiMonthlyBudgetUsd, 0, 'and no model spend at all');

  // The write path must refuse too — a denial that only exists in the read
  // callable is decoration.
  await expectFailure(
    call('createProposal', { proposal: proposalPayload({ title: 'P2 Legacy Denied' }) }, ctx.legacyAdmin),
    'failed-precondition',
    'proposal on an unentitled tenant',
  );

  const audits = await db
    .collection('auditLog')
    .where('companyId', '==', TENANT_LEGACY)
    .where('action', '==', 'entitlement.blocked')
    .limit(5)
    .get();
  assert.ok(audits.size > 0, 'the denial is auditable');
  assert.equal(audits.docs[0].data().detail.code, 'no_entitlement');
});

test('an explicit internal grant restores access, and clearing it denies again', async () => {
  // This is the legitimate path for Abrica and the development tenants: a
  // deliberate per-tenant grant, not an emergent default.
  await grantInternal(TENANT_LEGACY, { aiMonthlyBudgetUsd: 25 });

  const granted = await call('getCompanyEntitlements', {}, ctx.legacyAdmin);
  assert.equal(granted.state, 'granted');
  assert.equal(granted.grantKind, 'internal', 'an open-ended grant is internal, not a pilot');
  assert.equal(granted.needsPlan, false);
  assert.equal(granted.canGrow, true);
  assert.equal(granted.limits.maxActiveProposals, null, 'internal tenants are not plan-capped for growth');

  // Two proposals in a row, which the starter plan would have refused.
  const a = await call('createProposal', { proposal: proposalPayload({ title: 'P2 Legacy A' }) }, ctx.legacyAdmin);
  const b = await call('createProposal', { proposal: proposalPayload({ title: 'P2 Legacy B' }) }, ctx.legacyAdmin);
  assert.ok(a.id && b.id, 'an internal grant is not limited by a plan it never bought');

  // Clearing the grant must return the tenant to denied — proving the access was
  // the explicit grant and never an ambient default.
  await db.collection('entitlementOverrides').doc(TENANT_LEGACY).delete();
  const denied = await call('getCompanyEntitlements', {}, ctx.legacyAdmin);
  assert.equal(denied.state, 'unentitled', 'clearing the grant must deny again');
  assert.equal(denied.canGrow, false);
});

test('entitlement blocks are recorded in the audit trail', async () => {
  await activateSubscription();
  // Start from a known-empty slate: earlier tests left proposals behind, and this
  // test needs its FIRST create to succeed so that the SECOND is the one blocked.
  await clearProposals();

  /**
   * Clear this tenant's audit trail too.
   *
   * The trail is append-only across the whole run, so an earlier test's block (the
   * refused `user.create` invite) is still the NEWEST row by the time this runs —
   * and audit rows are not ordered by the query, so asserting on `docs[0]` was
   * asserting on whichever block happened to sort first. Dropping the tenant's trail
   * makes the assertion about this test's own block rather than a neighbour's.
   */
  const staleAudits = await db.collection('auditLog').where('companyId', '==', TENANT).get();
  await Promise.all(staleAudits.docs.map((d) => d.ref.delete()));

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
  // Assert on the block this test caused, not on document order.
  const proposalBlocks = auditSnap.docs.filter((d) => d.data().detail?.attempted === 'proposal.create');
  assert.equal(proposalBlocks.length, 1, 'exactly one proposal block is recorded');
  const detail = proposalBlocks[0].data().detail ?? {};
  assert.equal(detail.code, 'plan_limit_reached');
  assert.equal(detail.limit, 1, 'the refusal records the limit that was hit');
});
