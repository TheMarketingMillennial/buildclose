/**
 * Subscription entitlements — plans, lifecycle, grace periods, pilot overrides.
 *
 * Kept dependency-free (no Firebase, no config) for the same reason as
 * `company.ts` and `document.ts`: the enforcement points span several Cloud
 * Functions, and the rules they share must be proven by unit tests that need no
 * credentials. Every callable that needs to know "may this company do X" calls
 * into here; nothing re-implements a limit inline.
 *
 * ---------------------------------------------------------------------------
 * NO PRICING LIVES IN THIS FILE. NOT ONE NUMBER.
 *
 * A plan carries limits and feature flags, plus the Stripe price ids it can be
 * purchased through. It never carries an amount, because the moment an amount
 * exists in our code there are two sources of truth for what a customer pays and
 * the database one will eventually disagree with the charged one. Stripe owns
 * every monetary value; a plan is only ever *identified* here by its price ids.
 * `priceNote` exists purely so an admin can type "Contact sales" or "From $X"
 * into the dashboard for display, and is documented below as non-authoritative:
 * it is never parsed, never summed and never used to enforce anything.
 *
 * ---------------------------------------------------------------------------
 * THE GRANDFATHERING RULE (why `unsubscribed` is not `zero`).
 *
 * A company with no subscription record at all is not a lapsed customer — it is
 * a customer who predates billing, which at this point is every existing tenant.
 * Treating "no subscription" as "no entitlement" would have silently switched off
 * proposal creation for every one of them the day this module landed, breaking
 * the 113-test verified baseline for a product reason nobody asked for.
 *
 * So absence of a subscription resolves to `unsubscribed`, which grants the
 * legacy unlimited behaviour and says so loudly (`grandfathered: true`) so the
 * dashboard can nudge the account toward a plan. Only a tenant that HAS a
 * subscription and has LOST it becomes `restricted`. That distinction is the
 * whole reason the state machine below is not just a boolean.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LAPSED SUBSCRIPTION DOES NOT DO.
 *
 * `restricted` blocks growth — new seats, new proposals, new documents. It does
 * NOT break work that is already live. A proposal sitting in a prospect's inbox
 * keeps answering, because the customer's failed card is not the prospect's
 * problem, and destroying a deal in progress to collect a subscription is a
 * worse business outcome than a delayed invoice. This is a deliberate product
 * decision, tested explicitly in entitlements.test.mjs.
 */
import { z } from 'zod';

// ------------------------------------------------------------------- limits

/**
 * `null` means unlimited, `0` means forbidden.
 *
 * The distinction matters: a plan with `maxActiveProposals: 0` is a read-only
 * plan, whereas `null` is an uncapped one. Collapsing them to a single sentinel
 * (the usual `-1`) is how "unlimited" and "disabled" get confused in an
 * enforcement branch six months later.
 */
export const PlanLimits = z.object({
  /** Seats, excluding nobody — the company admin counts. null = unlimited. */
  maxUsers: z.number().int().min(0).nullable(),
  /** Proposals in `draft` or `published`. null = unlimited. */
  maxActiveProposals: z.number().int().min(0).nullable(),
  /** Total knowledge-base document storage, in megabytes. null = unlimited. */
  maxDocumentStorageMb: z.number().int().min(0).nullable(),
  /** Monthly AI spend ceiling in USD. null = no plan-imposed cap. */
  aiMonthlyBudgetUsd: z.number().min(0).nullable(),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

export const PlanFeatures = z.object({
  /** Knowledge-base uploads, embeddings, cited retrieval. */
  documentIntelligence: z.boolean(),
  /** Company Intelligence Center (Phase One). */
  companyIntelligence: z.boolean(),
  /** Whether the assistant may show the tenant's own branding. */
  customBranding: z.boolean(),
  /** Deep analytics: inferred intent, competitor tracking. */
  advancedAnalytics: z.boolean(),
});
export type PlanFeatures = z.infer<typeof PlanFeatures>;

export type FeatureKey = keyof PlanFeatures;
export const FEATURE_KEYS: FeatureKey[] = [
  'documentIntelligence',
  'companyIntelligence',
  'customBranding',
  'advancedAnalytics',
];

/**
 * A purchasable plan.
 *
 * `id` is a slug we choose ("growth"), stable across renames, and is what a
 * subscription stores. `stripePriceIds` maps the plan to one or more Stripe
 * prices (monthly/annual, legacy grandfathered prices) so a price change in
 * Stripe never requires a code deploy or a data migration.
 */
export const PlanDefinition = z.object({
  id: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use a lowercase slug'),
  name: z.string().min(1).max(80),
  description: z.string().max(600).default(''),
  /** Every Stripe price that grants this plan. Amounts live in Stripe only. */
  stripePriceIds: z.array(z.string().min(1).max(200)).max(20).default([]),
  limits: PlanLimits,
  features: PlanFeatures,
  /**
   * DISPLAY ONLY. Shown in the dashboard next to the plan name so an admin can
   * write "Contact sales" for a negotiated pilot. Never parsed, never summed,
   * never used in an enforcement decision — the checkout amount comes from
   * Stripe's price object.
   */
  priceNote: z.string().max(80).default(''),
  /** Days of grace after a failed payment before the account is restricted. */
  gracePeriodDays: z.number().int().min(0).max(90).default(7),
  /** Whether the plan may still be purchased. Existing subscribers are unaffected. */
  active: z.boolean().default(true),
  /** Ordering in the pricing UI. */
  sortOrder: z.number().int().default(0),
});
export type PlanDefinition = z.infer<typeof PlanDefinition>;

// -------------------------------------------------------------- subscription

/**
 * Subscription status. The first block is Stripe's vocabulary verbatim, because
 * the webhook writes it straight through; the last two are ours.
 *
 * Keeping Stripe's names (rather than normalising to a smaller enum) means a
 * support engineer reading a Stripe dashboard and our record sees the same word,
 * which is worth more than a tidier type.
 */
export const SubscriptionStatus = z.enum([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
  'expired',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** The shape of `subscriptions/{companyId}` as this module reads it. */
export const SubscriptionRecord = z.object({
  companyId: z.string().min(1),
  status: SubscriptionStatus,
  /** Which plan the customer bought. Absent = not yet resolved. */
  planId: z.string().max(60).nullable().default(null),
  stripeCustomerId: z.string().max(200).nullable().default(null),
  stripeSubscriptionId: z.string().max(200).nullable().default(null),
  /** The price most recently attached — used to re-resolve the plan. */
  priceId: z.string().max(200).nullable().default(null),
  /** End of the paid (or trialing) period. Grace is measured from here. */
  currentPeriodEnd: z.date().nullable().default(null),
  cancelAtPeriodEnd: z.boolean().default(false),
  /** Set when Stripe tells us the trial ends. */
  trialEnd: z.date().nullable().default(null),
});
export type SubscriptionRecord = z.infer<typeof SubscriptionRecord>;

// ------------------------------------------------------------ pilot override

/**
 * A sanctioned administrative override, for pilot customers.
 *
 * Two rules make this safe to have at all:
 *
 *   1. IT MUST EXPIRE. `expiresAt` is REQUIRED whenever the override is enabled,
 *      and an expired override is ignored entirely at read time — not ignored in
 *      the dashboard, ignored in the resolver. A grant that could be created
 *      without an end date is how a free pilot quietly becomes a free plan
 *      forever, and no one notices because the dashboard just shows "Pilot".
 *
 *   2. IT IS ADMIN-ONLY AND AUDITED. The callable that writes this is gated on
 *      `platform_admin`, and every write appends an audit entry naming the
 *      operator, the tenant and the new limits. A pilot grant is a commercial
 *      decision and has to be attributable to a person.
 */
export const PilotOverride = z
  .object({
    enabled: z.boolean().default(false),
    /** Grant a plan's limits wholesale, or… */
    planId: z.string().max(60).nullable().default(null),
    /** …override individual limits on top of whatever plan is granted. */
    limits: PlanLimits.partial().optional(),
    features: PlanFeatures.partial().optional(),
    expiresAt: z.date().nullable().default(null),
    note: z.string().max(1000).default(''),
  })
  .refine((v) => !v.enabled || v.expiresAt instanceof Date, {
    message: 'A pilot override must have an expiry date',
    path: ['expiresAt'],
  });
export type PilotOverride = z.infer<typeof PilotOverride>;

// ------------------------------------------------------------------- states

/**
 * What a company's billing position means for what it may do.
 *
 *   unsubscribed — no subscription record; legacy/grandfathered. Full access.
 *   pilot        — an active, unexpired administrative override. Full access.
 *   active       — paid and current. Full access.
 *   trialing     — inside a trial. Full access.
 *   grace        — payment failed but inside the grace window. Full access, and
 *                  the dashboard must say so, because the customer is about to
 *                  lose access and only we know it.
 *   restricted   — lapsed. Growth blocked, live work preserved.
 */
export type EntitlementState = 'unsubscribed' | 'pilot' | 'active' | 'trialing' | 'grace' | 'restricted';

export interface ResolvedEntitlements {
  state: EntitlementState;
  planId: string | null;
  planName: string | null;
  limits: PlanLimits;
  features: PlanFeatures;
  /** True when access derives from the absence of billing, not from a grant. */
  grandfathered: boolean;
  /** May the company create new users, proposals and documents? */
  canGrow: boolean;
  /** Days left in the grace window, or null outside it. */
  graceDaysRemaining: number | null;
  /** ISO date the pilot override or paid period ends, when known. */
  endsAt: string | null;
  cancelAtPeriodEnd: boolean;
  /** Machine-readable explanation for the dashboard, never shown to a prospect. */
  reasons: string[];
}

/** Unlimited, for tenants that predate billing. */
const LEGACY_LIMITS: PlanLimits = {
  maxUsers: null,
  maxActiveProposals: null,
  maxDocumentStorageMb: null,
  aiMonthlyBudgetUsd: null,
};

const LEGACY_FEATURES: PlanFeatures = {
  documentIntelligence: true,
  companyIntelligence: true,
  customBranding: true,
  advancedAnalytics: true,
};

/**
 * Fail-closed defaults when a subscription names a plan that cannot be resolved.
 *
 * This is not a "free tier" — it is what a company gets when their plan record
 * was deleted or their price is unknown, and it deliberately grants almost
 * nothing that costs us money while still letting existing live proposals run.
 * A resolver that fell back to unlimited on an unknown plan would turn a data
 * bug into a revenue leak.
 */
const UNKNOWN_PLAN_LIMITS: PlanLimits = {
  maxUsers: 0,
  maxActiveProposals: 0,
  maxDocumentStorageMb: 0,
  aiMonthlyBudgetUsd: null, // null so prospect chat keeps working; see below
};

const UNKNOWN_PLAN_FEATURES: PlanFeatures = {
  documentIntelligence: false,
  companyIntelligence: true,
  customBranding: false,
  advancedAnalytics: false,
};

/**
 * Limits applied once a paid subscription has actually lapsed.
 *
 * Growth is zeroed; the AI allowance becomes `null` ("no plan-imposed cap") so
 * the per-company setting continues to govern and a live prospect conversation is
 * not severed by a failed card. See the module header.
 */
function restrictedLimits(lapsedPlan: PlanLimits | null): PlanLimits {
  return {
    maxUsers: 0,
    maxActiveProposals: 0,
    maxDocumentStorageMb: 0,
    aiMonthlyBudgetUsd: lapsedPlan?.aiMonthlyBudgetUsd ?? null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

// ---------------------------------------------------------------- resolution

export interface ResolveInput {
  subscription: SubscriptionRecord | null;
  /** The plan the subscription points at, already looked up by the caller. */
  plan: PlanDefinition | null;
  /** A plan granted by the pilot override, when `override.planId` is set. */
  overridePlan?: PlanDefinition | null;
  override: PilotOverride | null;
  /** Injected so every lifecycle branch is testable without freezing time. */
  now: Date;
}

/**
 * Resolve what a company is entitled to right now.
 *
 * Order of precedence, and why:
 *   1. Pilot override — it exists precisely to put a customer outside normal
 *      billing for a while, so it must beat the subscription it is standing in
 *      for. Expiry is checked first so a stale grant is dead on arrival.
 *   2. No subscription — grandfathered.
 *   3. The subscription's own status and dates.
 */
export function resolveEntitlements(input: ResolveInput): ResolvedEntitlements {
  const { subscription, plan, override, now } = input;

  // ---- 1. pilot override ----
  if (override?.enabled && override.expiresAt && override.expiresAt.getTime() > now.getTime()) {
    const granted = input.overridePlan ?? plan;
    const baseLimits = granted?.limits ?? LEGACY_LIMITS;
    const baseFeatures = granted?.features ?? LEGACY_FEATURES;

    const limits: PlanLimits = { ...baseLimits, ...definedOnly(override.limits) };
    const features: PlanFeatures = { ...baseFeatures, ...definedOnly(override.features) };

    return {
      state: 'pilot',
      planId: override.planId ?? granted?.id ?? null,
      planName: granted?.name ?? 'Pilot',
      limits,
      features,
      grandfathered: false,
      canGrow: true,
      graceDaysRemaining: null,
      endsAt: override.expiresAt.toISOString(),
      cancelAtPeriodEnd: false,
      reasons: ['pilot_override_active'],
    };
  }

  // ---- 2. no subscription: grandfathered ----
  if (!subscription) {
    return {
      state: 'unsubscribed',
      planId: null,
      planName: null,
      limits: LEGACY_LIMITS,
      features: LEGACY_FEATURES,
      grandfathered: true,
      canGrow: true,
      graceDaysRemaining: null,
      endsAt: null,
      cancelAtPeriodEnd: false,
      reasons: ['no_subscription_on_record'],
    };
  }

  const status = subscription.status;
  const periodEnd = subscription.currentPeriodEnd;
  const periodEnded = periodEnd !== null && periodEnd.getTime() <= now.getTime();

  // ---- 3. subscription-driven states ----
  switch (status) {
    case 'active': {
      // Paid through the period, even if a cancellation is scheduled for its end.
      if (periodEnded) return restrictedFor(subscription, plan, now, ['period_ended_without_renewal']);
      return grant('active', subscription, plan, {
        endsAt: subscription.cancelAtPeriodEnd && periodEnd ? periodEnd.toISOString() : null,
        reasons: subscription.cancelAtPeriodEnd ? ['cancels_at_period_end'] : [],
      });
    }

    case 'trialing': {
      const trialEnd = subscription.trialEnd ?? periodEnd;
      if (trialEnd && trialEnd.getTime() <= now.getTime()) {
        // A finished trial is not a paid customer. Restricted, not unsubscribed:
        // they had a grant and lost it, so growth stops.
        return restrictedFor(subscription, plan, now, ['trial_expired']);
      }
      return grant('trialing', subscription, plan, {
        endsAt: trialEnd ? trialEnd.toISOString() : null,
        reasons: [],
      });
    }

    case 'past_due': {
      const graceDays = plan?.gracePeriodDays ?? 0;
      // Grace runs from the end of the period they stopped paying for.
      const graceEnds = periodEnd ? addDays(periodEnd, graceDays) : null;
      if (graceEnds && graceEnds.getTime() > now.getTime()) {
        const remaining = Math.ceil((graceEnds.getTime() - now.getTime()) / DAY_MS);
        return {
          ...grant('grace', subscription, plan, {
            endsAt: graceEnds.toISOString(),
            reasons: ['payment_failed_within_grace'],
          }),
          graceDaysRemaining: remaining,
        };
      }
      return restrictedFor(subscription, plan, now, ['grace_period_expired']);
    }

    case 'canceled': {
      // Stripe keeps the subscription "active" until period end when set to
      // cancel at period end, so a `canceled` status with future period means the
      // cancellation was immediate; with a past period it simply lapsed.
      if (periodEnd && periodEnd.getTime() > now.getTime() && !periodEnded) {
        return grant('active', subscription, plan, {
          endsAt: periodEnd.toISOString(),
          reasons: ['paid_through_period_after_cancellation'],
        });
      }
      return restrictedFor(subscription, plan, now, ['subscription_canceled']);
    }

    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    case 'paused':
    case 'expired':
    default:
      return restrictedFor(subscription, plan, now, [`status_${status}`]);
  }
}

/** Drop keys whose value is `undefined`, so a partial override cannot blank a limit. */
function definedOnly<T extends Record<string, unknown>>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function grant(
  state: Extract<EntitlementState, 'active' | 'trialing' | 'grace'>,
  subscription: SubscriptionRecord,
  plan: PlanDefinition | null,
  extra: { endsAt: string | null; reasons: string[] },
): ResolvedEntitlements {
  const resolvedPlan = plan !== null;
  return {
    state,
    planId: subscription.planId ?? plan?.id ?? null,
    planName: plan?.name ?? null,
    limits: plan?.limits ?? UNKNOWN_PLAN_LIMITS,
    features: plan?.features ?? UNKNOWN_PLAN_FEATURES,
    grandfathered: false,
    canGrow: true,
    graceDaysRemaining: null,
    endsAt: extra.endsAt,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    reasons: resolvedPlan ? extra.reasons : [...extra.reasons, 'plan_unresolved'],
  };
}

function restrictedFor(
  subscription: SubscriptionRecord,
  plan: PlanDefinition | null,
  now: Date,
  reasons: string[],
): ResolvedEntitlements {
  void now;
  return {
    state: 'restricted',
    planId: subscription.planId ?? plan?.id ?? null,
    planName: plan?.name ?? null,
    limits: restrictedLimits(plan?.limits ?? null),
    features: {
      // Read-only access to what they already built. Document *retrieval* keeps
      // working for existing proposals; new uploads are blocked by the zero limit.
      documentIntelligence: false,
      companyIntelligence: true,
      customBranding: plan?.features.customBranding ?? false,
      advancedAnalytics: false,
    },
    grandfathered: false,
    canGrow: false,
    graceDaysRemaining: null,
    endsAt: null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    reasons,
  };
}

// ---------------------------------------------------------------- decisions

export type EntitlementCode =
  | 'ok'
  | 'plan_limit_reached'
  | 'feature_not_in_plan'
  | 'subscription_inactive'
  | 'ai_budget_exceeded';

export interface EntitlementDecision {
  allowed: boolean;
  code: EntitlementCode;
  /** Staff-facing and safe to surface; never shown to a prospect. */
  message: string;
  limit?: number | null;
  use?: number;
}

const OK: EntitlementDecision = { allowed: true, code: 'ok', message: 'OK' };

/** Adding a seat. `currentUsers` must include the admin and any pending invites. */
export function checkCanAddUser(ent: ResolvedEntitlements, currentUsers: number): EntitlementDecision {
  if (!ent.canGrow) {
    return {
      allowed: false,
      code: 'subscription_inactive',
      message: 'Your subscription is not active, so new team members cannot be added. Update billing to restore access.',
    };
  }
  if (ent.limits.maxUsers === null) return OK;
  if (currentUsers + 1 > ent.limits.maxUsers) {
    return {
      allowed: false,
      code: 'plan_limit_reached',
      message: `Your plan includes ${ent.limits.maxUsers} user${ent.limits.maxUsers === 1 ? '' : 's'}. Upgrade to add more.`,
      limit: ent.limits.maxUsers,
      use: currentUsers,
    };
  }
  return OK;
}

/** Creating a proposal (drafts count — a draft is an active proposal). */
export function checkCanCreateProposal(
  ent: ResolvedEntitlements,
  currentActiveProposals: number,
): EntitlementDecision {
  if (!ent.canGrow) {
    return {
      allowed: false,
      code: 'subscription_inactive',
      message: 'Your subscription is not active, so new proposals cannot be created. Existing proposals keep working.',
    };
  }
  if (ent.limits.maxActiveProposals === null) return OK;
  if (currentActiveProposals + 1 > ent.limits.maxActiveProposals) {
    return {
      allowed: false,
      code: 'plan_limit_reached',
      message: `Your plan includes ${ent.limits.maxActiveProposals} active proposal${ent.limits.maxActiveProposals === 1 ? '' : 's'}. Archive or upgrade to create more.`,
      limit: ent.limits.maxActiveProposals,
      use: currentActiveProposals,
    };
  }
  return OK;
}

/** Storing new knowledge documents. `addMb` is the incoming document's size. */
export function checkCanStoreDocuments(
  ent: ResolvedEntitlements,
  currentMb: number,
  addMb: number,
): EntitlementDecision {
  if (!ent.features.documentIntelligence) {
    return {
      allowed: false,
      code: 'feature_not_in_plan',
      message: 'Document uploads are not included in your plan.',
    };
  }
  if (!ent.canGrow) {
    return {
      allowed: false,
      code: 'subscription_inactive',
      message: 'Your subscription is not active, so new documents cannot be uploaded.',
    };
  }
  if (ent.limits.maxDocumentStorageMb === null) return OK;
  if (currentMb + addMb > ent.limits.maxDocumentStorageMb) {
    return {
      allowed: false,
      code: 'plan_limit_reached',
      message: `Your plan includes ${ent.limits.maxDocumentStorageMb} MB of document storage. Upgrade or remove documents to upload more.`,
      limit: ent.limits.maxDocumentStorageMb,
      use: currentMb,
    };
  }
  return OK;
}

export function checkFeature(ent: ResolvedEntitlements, feature: FeatureKey): EntitlementDecision {
  if (ent.features[feature]) return OK;
  return {
    allowed: false,
    code: 'feature_not_in_plan',
    message: `${FEATURE_LABELS[feature]} is not included in your plan.`,
  };
}

const FEATURE_LABELS: Record<FeatureKey, string> = {
  documentIntelligence: 'Document intelligence',
  companyIntelligence: 'The Company Intelligence Center',
  customBranding: 'Custom branding',
  advancedAnalytics: 'Advanced analytics',
};

/**
 * The monthly AI ceiling actually in force, in USD, or null for "no ceiling".
 *
 * THE TIGHTER OF THE TWO, the same principle as Phase One's commercial
 * authority: a plan may lower the allowance a company configured for itself, but
 * a company setting may never raise itself above what it bought. Getting this
 * backwards would let an admin type `aiBudgetUsd: 100000` into the company
 * document and silently override the plan.
 *
 * An `unsubscribed` (grandfathered) tenant has `aiMonthlyBudgetUsd: null`, so its
 * own setting governs and existing behaviour is preserved exactly.
 */
export function effectiveAiBudgetUsd(
  ent: ResolvedEntitlements,
  companySettingUsd: number | null | undefined,
): number | null {
  const planCap = ent.limits.aiMonthlyBudgetUsd;
  const companyCap = typeof companySettingUsd === 'number' && Number.isFinite(companySettingUsd)
    ? companySettingUsd
    : null;

  if (planCap === null && companyCap === null) return null;
  if (planCap === null) return companyCap;
  if (companyCap === null) return planCap;
  return Math.min(planCap, companyCap);
}

/**
 * True when the company has spent its whole allowance this month.
 *
 * `companyBudgetUsd` is the caller's company-level setting, ALREADY defaulted to
 * the platform fallback when unset. That defaulting belongs to the caller because
 * the fallback is an operational constant, not an entitlement rule.
 *
 * There is deliberately no special case for `restricted` tenants. `effectiveAiBudgetUsd`
 * already returns the TIGHTER of the (possibly lapsed) plan cap and the company
 * setting, so a lapsed tenant is capped at whichever is lower — which is exactly
 * the behaviour we want: a live prospect conversation is not severed by a failed
 * card, but a lapsed account cannot generate unlimited new model spend either.
 * An explicit zero cap on a lapsed plan still blocks, because `min(0, n) = 0`.
 */
export function checkAiBudget(
  ent: ResolvedEntitlements,
  spentMicroUsd: number,
  companyBudgetUsd: number | null | undefined,
): EntitlementDecision {
  const budget = effectiveAiBudgetUsd(ent, companyBudgetUsd);
  if (budget === null) return OK;
  if (spentMicroUsd >= budget * 1_000_000) {
    return {
      allowed: false,
      code: 'ai_budget_exceeded',
      message: 'The monthly AI allowance for this account has been reached.',
    };
  }
  return OK;
}

// ------------------------------------------------------------------- helpers

/**
 * Find the plan that grants a Stripe price.
 *
 * Used by the webhook when Stripe tells us which price a subscription carries but
 * not which of our plans that is. An inactive plan still matches, because an
 * existing subscriber on a retired plan must keep the plan they bought — retiring
 * a plan stops new purchases, it does not evict current customers.
 */
export function planForPriceId(plans: PlanDefinition[], priceId: string | null | undefined): PlanDefinition | null {
  if (!priceId) return null;
  return plans.find((p) => p.stripePriceIds.includes(priceId)) ?? null;
}

/** The plan a new checkout should use for a given id. Only active plans sell. */
export function sellablePlan(plans: PlanDefinition[], planId: string): PlanDefinition | null {
  return plans.find((p) => p.id === planId && p.active) ?? null;
}

/** Stable ordering for the pricing UI. */
export function sortPlans(plans: PlanDefinition[]): PlanDefinition[] {
  return [...plans].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * A short, staff-facing summary of the billing position.
 * Deliberately terse — the dashboard renders it in a status pill.
 */
export function describeEntitlements(ent: ResolvedEntitlements): string {
  switch (ent.state) {
    case 'unsubscribed':
      return 'No plan';
    case 'pilot':
      return `Pilot — ${ent.planName ?? 'granted access'}`;
    case 'active':
      return ent.cancelAtPeriodEnd ? `${ent.planName ?? 'Active'} — cancels at period end` : ent.planName ?? 'Active';
    case 'trialing':
      return `Trial — ${ent.planName ?? 'in progress'}`;
    case 'grace':
      return `Payment failed — ${ent.graceDaysRemaining ?? 0} day${ent.graceDaysRemaining === 1 ? '' : 's'} of access left`;
    case 'restricted':
      return 'Restricted — subscription inactive';
    default:
      return 'Unknown';
  }
}
