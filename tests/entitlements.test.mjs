/**
 * Subscription entitlements tests — lifecycle, grace, pilot overrides, limits.
 *
 * Pure logic: no emulator, no credentials, so these gate every commit cheaply and
 * can never be skipped for environmental reasons.
 *
 * What is proven here, in order of how badly it would hurt to get wrong:
 *
 *   1. DENY BY DEFAULT. A tenant with no subscription and no grant is `unentitled`:
 *      no seats, no proposals, no storage, and ZERO AI allowance. The absence of a
 *      billing record must never be read as permission — that was a real defect in
 *      the first draft, where any company record at all could run proposals and
 *      burn model spend without ever being sold anything.
 *   2. An explicit internal grant restores access for tenants that legitimately
 *      predate billing (Abrica, the development tenants). Note it does NOT grant
 *      unlimited AI: it removes the PLAN cap so the company's own finite setting
 *      governs.
 *   3. A pilot grant beats a lapsed subscription, but only until it expires. A
 *      pilot that outlives its expiry date is a free plan forever.
 *   4. Grace is measured from the end of the unpaid period, and clamps to zero.
 *   5. A lapsed subscription blocks growth WITHOUT severing a live prospect
 *      conversation, and is capped at LAPSED_AI_ALLOWANCE_USD — a little, not none
 *      and not unlimited.
 *   6. The AI ceiling is the TIGHTER of plan and company setting — a company can
 *      never raise itself above the plan it bought.
 *   7. Existing proposal access is preserved regardless of billing state.
 *   8. No monetary amount is stored on a plan. Stripe owns every price.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PlanDefinition,
  PilotOverride,
  resolveEntitlements,
  checkCanAddUser,
  checkCanCreateProposal,
  checkCanStoreDocuments,
  checkFeature,
  effectiveAiBudgetUsd,
  checkAiBudget,
  planForPriceId,
  sellablePlan,
  sortPlans,
  describeEntitlements,
  proposalAccessPreserved,
  LAPSED_AI_ALLOWANCE_USD,
} from '../functions/lib/lib/entitlements.js';

// ---------------------------------------------------------------------- setup

const NOW = new Date('2026-11-25T12:00:00.000Z');
const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

/** A growth plan: 5 seats, 40 active proposals, 200 MB, $30 AI. */
function plan(overrides = {}) {
  return PlanDefinition.parse({
    id: 'growth',
    name: 'Growth',
    description: 'For teams running proposals every week.',
    stripePriceIds: ['price_growth_monthly'],
    limits: {
      maxUsers: 5,
      maxActiveProposals: 40,
      maxDocumentStorageMb: 200,
      aiMonthlyBudgetUsd: 30,
    },
    features: {
      documentIntelligence: true,
      companyIntelligence: true,
      customBranding: true,
      advancedAnalytics: false,
    },
    priceNote: 'Contact sales',
    gracePeriodDays: 7,
    active: true,
    sortOrder: 10,
    ...overrides,
  });
}

function sub(overrides = {}) {
  return {
    companyId: 'co-1',
    status: 'active',
    planId: 'growth',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    priceId: 'price_growth_monthly',
    currentPeriodEnd: days(20),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    ...overrides,
  };
}

function resolve(overrides = {}) {
  return resolveEntitlements({
    subscription: null,
    plan: null,
    override: null,
    now: NOW,
    ...overrides,
  });
}

// ------------------------------------------------ deny by default (no billing)

test('a company with NO subscription and NO grant is denied everything', () => {
  const ent = resolve();

  assert.equal(ent.state, 'unentitled');
  assert.equal(ent.needsPlan, true, 'the dashboard must prompt for a plan');
  assert.equal(ent.canGrow, false);
  assert.equal(ent.limits.maxUsers, 0);
  assert.equal(ent.limits.maxActiveProposals, 0);
  assert.equal(ent.limits.maxDocumentStorageMb, 0);
  assert.equal(ent.limits.aiMonthlyBudgetUsd, 0, 'no model spend at all');
  assert.deepEqual(ent.reasons, ['no_entitlement_granted']);
});

test('an absent subscription is never read as permission', () => {
  const ent = resolve();

  assert.equal(checkCanAddUser(ent, 0).allowed, false);
  assert.equal(checkCanCreateProposal(ent, 0).allowed, false);
  assert.equal(checkCanStoreDocuments(ent, 0, 1).allowed, false);
  assert.equal(checkCanAddUser(ent, 0).code, 'no_entitlement');
});

test('an unentitled company cannot spend a single cent of AI budget', () => {
  const ent = resolve();
  assert.equal(effectiveAiBudgetUsd(ent, 25), 0, 'a large company setting cannot unlock spend');
  assert.equal(effectiveAiBudgetUsd(ent, null), 0);
  assert.equal(checkAiBudget(ent, 0, 25).allowed, false, 'zero spent still exceeds a zero cap');
  assert.equal(checkAiBudget(ent, 0, 25).code, 'no_entitlement');
});

// ------------------------------------------------------- internal grants

test('an internal grant restores access for a tenant that predates billing', () => {
  const ent = resolve({
    override: PilotOverride.parse({ enabled: true, kind: 'internal', expiresAt: null }),
  });

  assert.equal(ent.state, 'granted');
  assert.equal(ent.grantKind, 'internal');
  assert.equal(ent.needsPlan, false);
  assert.equal(ent.canGrow, true);
  assert.equal(ent.limits.maxUsers, null, 'uncapped seats');
  assert.equal(ent.limits.maxActiveProposals, null, 'uncapped proposals');
  assert.deepEqual(ent.reasons, ['internal_grant_active']);
});

test('an internal grant does NOT grant unlimited AI spend', () => {
  const ent = resolve({
    override: PilotOverride.parse({ enabled: true, kind: 'internal', expiresAt: null }),
  });

  // The grant removes the PLAN cap (null), so the company's own finite setting
  // governs. It is not "unlimited"; it is "not bounded by a plan we never sold".
  assert.equal(ent.limits.aiMonthlyBudgetUsd, null);
  assert.equal(effectiveAiBudgetUsd(ent, 25), 25);
  assert.equal(checkAiBudget(ent, 24_000_000, 25).allowed, true);
  assert.equal(checkAiBudget(ent, 25_000_000, 25).allowed, false);
});

test('an internal grant may be open-ended and still applies', () => {
  const ent = resolve({
    override: PilotOverride.parse({ enabled: true, kind: 'internal', expiresAt: null }),
  });
  assert.equal(ent.endsAt, null, 'no expiry for an internal tenant');
  assert.equal(ent.state, 'granted');
});

test('a pilot grant still REQUIRES an expiry, internal does not', () => {
  assert.equal(
    PilotOverride.safeParse({ enabled: true, kind: 'pilot', expiresAt: null }).success,
    false,
    'a time-boxed pilot without an end date must not be storable',
  );
  assert.equal(
    PilotOverride.safeParse({ enabled: true, kind: 'internal', expiresAt: null }).success,
    true,
    'an internal tenant is outside billing by decision, not on a clock',
  );
});

// ----------------------------------------------------------- pilot overrides

test('an active pilot override grants its plan and beats a lapsed subscription', () => {
  const ent = resolve({
    // A canceled subscription that would otherwise restrict the tenant.
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-30) }),
    plan: plan(),
    override: PilotOverride.parse({ enabled: true, planId: 'growth', expiresAt: days(14) }),
    overridePlan: plan(),
  });

  assert.equal(ent.state, 'granted');
  assert.equal(ent.grantKind, 'pilot');
  assert.equal(ent.canGrow, true);
  assert.equal(ent.planId, 'growth');
  assert.equal(ent.limits.maxUsers, 5);
  assert.equal(ent.endsAt, days(14).toISOString());
  assert.deepEqual(ent.reasons, ['pilot_grant_active']);
});

test('an EXPIRED pilot override is ignored at read time, not just hidden in the UI', () => {
  const ent = resolve({
    subscription: null,
    override: PilotOverride.parse({ enabled: true, expiresAt: days(-1) }),
  });

  // Falls through to the no-subscription branch, i.e. denied — not to granted.
  assert.equal(ent.state, 'unentitled');
  assert.deepEqual(ent.reasons, ['no_entitlement_granted']);
});

test('an expired pilot override lets a lapsed subscription restrict the tenant', () => {
  const ent = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-30) }),
    plan: plan(),
    override: PilotOverride.parse({ enabled: true, planId: 'growth', expiresAt: days(-1) }),
    overridePlan: plan(),
  });

  assert.equal(ent.state, 'restricted');
  assert.equal(ent.canGrow, false);
});

test('a pilot override is REFUSED by the schema when enabled without an expiry', () => {
  const result = PilotOverride.safeParse({ enabled: true, planId: 'growth', expiresAt: null });
  assert.equal(result.success, false, 'a grant with no end date must not be storable');
  const issue = result.error.issues[0];
  assert.equal(issue.path.join('.'), 'expiresAt');
});

test('a pilot override may grant limits without naming a plan', () => {
  const ent = resolve({
    override: PilotOverride.parse({
      enabled: true,
      expiresAt: days(5),
      limits: { maxUsers: 2, maxActiveProposals: 3 },
    }),
  });

  assert.equal(ent.state, 'granted');
  assert.equal(ent.planName, 'Pilot');
  assert.equal(ent.limits.maxUsers, 2);
  assert.equal(ent.limits.maxActiveProposals, 3);
});

test('partial pilot limits do not blank the limits inherited from the granted plan', () => {
  const ent = resolve({
    override: PilotOverride.parse({
      enabled: true,
      planId: 'growth',
      expiresAt: days(5),
      limits: { maxUsers: 9 },
    }),
    overridePlan: plan(),
  });

  assert.equal(ent.limits.maxUsers, 9, 'the override applies');
  assert.equal(ent.limits.maxActiveProposals, 40, 'the plan value survives');
  assert.equal(ent.limits.maxDocumentStorageMb, 200, 'and so does storage');
});

test('a disabled grant changes nothing', () => {
  const ent = resolve({ override: PilotOverride.parse({ enabled: false, expiresAt: days(30) }) });
  assert.equal(ent.state, 'unentitled');
});

// ---------------------------------------------------------------- paid states

test('an active subscription with a future period is active', () => {
  const ent = resolve({ subscription: sub(), plan: plan() });

  assert.equal(ent.state, 'active');
  assert.equal(ent.canGrow, true);
  assert.equal(ent.needsPlan, false);
  assert.equal(ent.planName, 'Growth');
  assert.equal(ent.limits.maxUsers, 5);
});

test('an active subscription whose period already ended is restricted, not active', () => {
  const ent = resolve({
    subscription: sub({ status: 'active', currentPeriodEnd: days(-1) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'restricted');
  assert.deepEqual(ent.reasons, ['period_ended_without_renewal']);
});

test('cancelling at period end keeps access until the period ends', () => {
  const ent = resolve({
    subscription: sub({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: days(10) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'active');
  assert.equal(ent.canGrow, true);
  assert.equal(ent.cancelAtPeriodEnd, true);
  assert.equal(ent.endsAt, days(10).toISOString());
  assert.deepEqual(ent.reasons, ['cancels_at_period_end']);
});

test('a trial inside its window is entitled', () => {
  const ent = resolve({
    subscription: sub({ status: 'trialing', trialEnd: days(3), currentPeriodEnd: days(3) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'trialing');
  assert.equal(ent.canGrow, true);
  assert.equal(ent.endsAt, days(3).toISOString());
});

test('an expired trial loses growth but is not treated as never-subscribed', () => {
  const ent = resolve({
    subscription: sub({ status: 'trialing', trialEnd: days(-2), currentPeriodEnd: days(-2) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'restricted');
  assert.deepEqual(ent.reasons, ['trial_expired']);
});

// --------------------------------------------------------------------- grace

test('past_due inside the grace window keeps full access and reports days left', () => {
  const ent = resolve({
    subscription: sub({ status: 'past_due', currentPeriodEnd: days(-3) }),
    plan: plan(), // gracePeriodDays: 7
  });

  assert.equal(ent.state, 'grace');
  assert.equal(ent.canGrow, true, 'grace must not block work');
  assert.equal(ent.graceDaysRemaining, 4, 'seven days of grace, three already used');
  assert.equal(ent.endsAt, days(4).toISOString());
});

test('past_due beyond the grace window is restricted', () => {
  const ent = resolve({
    subscription: sub({ status: 'past_due', currentPeriodEnd: days(-10) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'restricted');
  assert.deepEqual(ent.reasons, ['grace_period_expired']);
});

test('a plan with zero grace days restricts a failed payment immediately', () => {
  const ent = resolve({
    subscription: sub({ status: 'past_due', currentPeriodEnd: days(-1) }),
    plan: plan({ gracePeriodDays: 0 }),
  });

  assert.equal(ent.state, 'restricted');
});

test('past_due with no period end cannot claim grace', () => {
  const ent = resolve({
    subscription: sub({ status: 'past_due', currentPeriodEnd: null }),
    plan: plan(),
  });

  assert.equal(ent.state, 'restricted');
});

// ------------------------------------------------------------- cancellation

test('a canceled subscription still inside a paid period keeps access', () => {
  const ent = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(12) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'active');
  assert.equal(ent.canGrow, true);
  assert.deepEqual(ent.reasons, ['paid_through_period_after_cancellation']);
});

test('a canceled subscription past its period is restricted', () => {
  const ent = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-1) }),
    plan: plan(),
  });

  assert.equal(ent.state, 'restricted');
  assert.deepEqual(ent.reasons, ['subscription_canceled']);
});

test('incomplete, unpaid, paused and expired statuses all restrict', () => {
  for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'expired']) {
    const ent = resolve({ subscription: sub({ status }), plan: plan() });
    assert.equal(ent.state, 'restricted', `${status} must restrict`);
    assert.deepEqual(ent.reasons, [`status_${status}`]);
  }
});

// ---------------------------------------------- lapsed tenant keeps live work

test('a restricted tenant cannot grow', () => {
  const ent = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-5) }),
    plan: plan(),
  });

  const user = checkCanAddUser(ent, 1);
  assert.equal(user.allowed, false);
  assert.equal(user.code, 'subscription_inactive');

  const proposal = checkCanCreateProposal(ent, 0);
  assert.equal(proposal.allowed, false);
  assert.equal(proposal.code, 'subscription_inactive');

  const docs = checkCanStoreDocuments(ent, 0, 1);
  assert.equal(docs.allowed, false);
});

test('a restricted tenant does NOT have live prospect conversations severed', () => {
  const lapsed = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-5) }),
    plan: plan(), // plan cap $30
  });

  // Not zero: a prospect mid-negotiation keeps getting answers.
  assert.equal(lapsed.limits.aiMonthlyBudgetUsd, LAPSED_AI_ALLOWANCE_USD);
  assert.equal(checkAiBudget(lapsed, 0, 25).allowed, true, 'the floor leaves real headroom');
  // Not unlimited: the company's own large setting cannot reopen the tap.
  assert.equal(checkAiBudget(lapsed, 1_500_000, 10_000).allowed, true);
  assert.equal(checkAiBudget(lapsed, 2_000_000, 10_000).allowed, false, 'hard ceiling at the floor');
});

// ------------------------------------------------------------- plan resolution

test('an unresolvable plan fails CLOSED on growth rather than granting unlimited', () => {
  const ent = resolve({
    // Subscription references a plan that no longer exists in the plans collection.
    subscription: sub({ planId: 'deleted-plan' }),
    plan: null,
  });

  assert.equal(ent.state, 'active', 'they are paid, just unresolvable');
  assert.equal(ent.limits.maxUsers, 0, 'fail closed, not open');
  assert.equal(ent.limits.maxActiveProposals, 0);
  assert.equal(ent.limits.maxDocumentStorageMb, 0);
  assert.ok(ent.reasons.includes('plan_unresolved'), 'and say why');
});

test('planForPriceId resolves a price to its plan, including retired plans', () => {
  const plans = [plan(), plan({ id: 'legacy', name: 'Legacy', stripePriceIds: ['price_legacy'], active: false })];

  assert.equal(planForPriceId(plans, 'price_growth_monthly')?.id, 'growth');
  assert.equal(
    planForPriceId(plans, 'price_legacy')?.id,
    'legacy',
    'an existing subscriber keeps a retired plan',
  );
  assert.equal(planForPriceId(plans, 'price_unknown'), null);
  assert.equal(planForPriceId(plans, null), null);
});

test('sellablePlan refuses a retired plan for a NEW purchase', () => {
  const plans = [plan(), plan({ id: 'legacy', name: 'Legacy', active: false })];

  assert.equal(sellablePlan(plans, 'growth')?.id, 'growth');
  assert.equal(sellablePlan(plans, 'legacy'), null, 'retired plans cannot be bought');
  assert.equal(sellablePlan(plans, 'nope'), null);
});

test('sortPlans orders by sortOrder then name', () => {
  const sorted = sortPlans([
    plan({ id: 'c', name: 'Charlie', sortOrder: 2 }),
    plan({ id: 'a', name: 'Alpha', sortOrder: 1 }),
    plan({ id: 'b', name: 'Bravo', sortOrder: 1 }),
  ]);
  assert.deepEqual(sorted.map((p) => p.id), ['a', 'b', 'c']);
});

// ------------------------------------------------------------------- limits

test('user limit is inclusive and blocks the next seat', () => {
  const ent = resolve({ subscription: sub(), plan: plan() }); // maxUsers 5
  assert.equal(checkCanAddUser(ent, 3).allowed, true);
  assert.equal(checkCanAddUser(ent, 4).allowed, true, 'the fifth seat fits');
  const blocked = checkCanAddUser(ent, 5);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'plan_limit_reached');
  assert.equal(blocked.limit, 5);
  assert.equal(blocked.use, 5);
});

test('proposal limit is inclusive and blocks the next proposal', () => {
  const ent = resolve({ subscription: sub(), plan: plan() }); // maxActiveProposals 40
  assert.equal(checkCanCreateProposal(ent, 39).allowed, true);
  assert.equal(checkCanCreateProposal(ent, 40).allowed, false);
});

test('document storage accumulates against the plan allowance', () => {
  const ent = resolve({ subscription: sub(), plan: plan() }); // 200 MB
  assert.equal(checkCanStoreDocuments(ent, 150, 50).allowed, true, 'exactly at the limit fits');
  assert.equal(checkCanStoreDocuments(ent, 150, 51).allowed, false);
});

test('document uploads are refused entirely when the plan lacks the feature', () => {
  const ent = resolve({
    subscription: sub(),
    plan: plan({ features: { documentIntelligence: false, companyIntelligence: true, customBranding: false, advancedAnalytics: false } }),
  });

  const decision = checkCanStoreDocuments(ent, 0, 1);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'feature_not_in_plan');
});

test('checkFeature reports the missing feature by name', () => {
  const ent = resolve({ subscription: sub(), plan: plan() }); // advancedAnalytics false
  assert.equal(checkFeature(ent, 'customBranding').allowed, true);
  const missing = checkFeature(ent, 'advancedAnalytics');
  assert.equal(missing.allowed, false);
  assert.match(missing.message, /Advanced analytics/);
});

test('a zero limit means forbidden, not unlimited', () => {
  const ent = resolve({
    subscription: sub(),
    plan: plan({
      limits: { maxUsers: 0, maxActiveProposals: 0, maxDocumentStorageMb: 0, aiMonthlyBudgetUsd: 0 },
    }),
  });

  assert.equal(checkCanAddUser(ent, 0).allowed, false);
  assert.equal(checkCanCreateProposal(ent, 0).allowed, false);
});

// -------------------------------------------------------------- AI budget cap

test('the AI ceiling is the tighter of plan and company setting', () => {
  const ent = resolve({ subscription: sub(), plan: plan() }); // plan cap $30

  assert.equal(effectiveAiBudgetUsd(ent, 25), 25, 'company lower than plan binds');
  assert.equal(effectiveAiBudgetUsd(ent, 100), 30, 'company cannot exceed the plan');
  assert.equal(effectiveAiBudgetUsd(ent, null), 30, 'plan governs when company is unset');
  assert.equal(effectiveAiBudgetUsd(ent, 30), 30, 'equal is fine');
});

test('an enormous company setting cannot buy extra AI beyond the plan', () => {
  const ent = resolve({ subscription: sub(), plan: plan() });
  assert.equal(effectiveAiBudgetUsd(ent, 100_000), 30);
  assert.equal(checkAiBudget(ent, 29_000_000, 100_000).allowed, true);
  assert.equal(checkAiBudget(ent, 30_000_000, 100_000).allowed, false);
});

test('unlimited plan + unset company means uncapped', () => {
  const ent = resolve({
    subscription: sub(),
    plan: plan({ limits: { maxUsers: 5, maxActiveProposals: 40, maxDocumentStorageMb: 200, aiMonthlyBudgetUsd: null } }),
  });
  assert.equal(effectiveAiBudgetUsd(ent, null), null);
});

// ----------------------------------------------------------- no prices stored

test('existing proposal access is preserved in every billing state', () => {
  // A proposal already sent to a prospect is a live commercial document. The
  // seller's billing position must never retract it.
  for (const ent of [
    resolve(), // unentitled
    resolve({ override: PilotOverride.parse({ enabled: true, kind: 'internal', expiresAt: null }) }),
    resolve({ subscription: sub(), plan: plan() }), // active
    resolve({ subscription: sub({ status: 'canceled', currentPeriodEnd: days(-9) }), plan: plan() }), // restricted
  ]) {
    assert.equal(proposalAccessPreserved(ent), true, `access must survive state ${ent.state}`);
  }
});

test('a lapsed account gets a little AI, not none and not unlimited', () => {
  const ent = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-5) }),
    plan: plan(), // plan cap $30
  });

  assert.equal(ent.state, 'restricted');
  assert.equal(ent.limits.aiMonthlyBudgetUsd, LAPSED_AI_ALLOWANCE_USD, 'capped at the lapsed floor');
  assert.ok(LAPSED_AI_ALLOWANCE_USD > 0, 'not zero: a live negotiation keeps answering');
  assert.ok(LAPSED_AI_ALLOWANCE_USD < 30, 'not unlimited: an expired account is not an API key');
  assert.equal(checkAiBudget(ent, 0, 1000).allowed, true, 'a little headroom remains');
  assert.equal(checkAiBudget(ent, 2_000_000, 1000).allowed, false, 'and it is a hard ceiling');
});

test('a lapsed enterprise plan does not keep its large AI allowance', () => {
  const ent = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-5) }),
    plan: plan({ limits: { maxUsers: 50, maxActiveProposals: 500, maxDocumentStorageMb: 5000, aiMonthlyBudgetUsd: 500 } }),
  });
  // Tighter of the plan cap and the lapsed floor.
  assert.equal(ent.limits.aiMonthlyBudgetUsd, LAPSED_AI_ALLOWANCE_USD);
});

test('a plan stores no monetary amount — Stripe owns every price', () => {
  const p = plan();

  const numericAmountFields = Object.entries(p).filter(
    ([k, v]) => typeof v === 'number' && /price|amount|cost|fee|usd|cent|minor/i.test(k) && k !== 'gracePeriodDays' && k !== 'sortOrder',
  );
  assert.deepEqual(numericAmountFields, [], 'no numeric monetary field may exist on a plan');

  // priceNote is display-only and must be a string, never a parsed amount.
  assert.equal(typeof p.priceNote, 'string');
  assert.equal(p.priceNote, 'Contact sales');
});

test('a plan id must be a lowercase slug', () => {
  assert.equal(PlanDefinition.safeParse({ ...plan(), id: 'Growth Plan' }).success, false);
  assert.equal(PlanDefinition.safeParse({ ...plan(), id: 'growth-2' }).success, true);
});

// --------------------------------------------------------------- describing

test('describeEntitlements produces a terse status for each state', () => {
  const denied = resolve();
  assert.equal(describeEntitlements(denied), 'No plan — access not granted');

  const active = resolve({ subscription: sub(), plan: plan() });
  assert.equal(describeEntitlements(active), 'Growth');

  const cancelling = resolve({
    subscription: sub({ cancelAtPeriodEnd: true }),
    plan: plan(),
  });
  assert.match(describeEntitlements(cancelling), /cancels at period end/);

  const grace = resolve({
    subscription: sub({ status: 'past_due', currentPeriodEnd: days(-3) }),
    plan: plan(),
  });
  assert.match(describeEntitlements(grace), /4 days of access left/);

  const restricted = resolve({
    subscription: sub({ status: 'canceled', currentPeriodEnd: days(-1) }),
    plan: plan(),
  });
  assert.match(describeEntitlements(restricted), /Restricted/);
});
