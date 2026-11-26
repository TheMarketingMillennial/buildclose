/**
 * Subscription entitlements — plans, lifecycle, grace periods, explicit grants.
 *
 * Kept dependency-free (no Firebase, no config) for the same reason as
 * `company.ts` and `document.ts`: the enforcement points span several Cloud
 * Functions, and the rules they share must be proven by unit tests that need no
 * credentials. Every callable that needs to know "may this company do X" calls
 * into here; nothing re-implements a limit inline.
 *
 * ---------------------------------------------------------------------------
 * DENY BY DEFAULT.
 *
 * A company with no subscription and no explicit grant is `unentitled`: no seats,
 * no new proposals, no document storage, and — importantly — no model spend. The
 * absence of a subscription record is NEVER read as permission. This was corrected
 * after a first draft treated "no subscription" as "grandfathered, unlimited",
 * which would have meant a company record created by any means at all could run
 * proposals and burn AI cost without ever being sold anything.
 *
 * Tenants that legitimately predate billing (Abrica, the development tenants) keep
 * working through an EXPLICIT grant — `kind: 'internal'` — recorded in
 * `entitlementOverrides/{companyId}` with the operator who created it. That is a
 * deliberate, auditable, per-tenant decision rather than an emergent default.
 *
 * ---------------------------------------------------------------------------
 * PROSPECTS DO NOT NEED A SUBSCRIPTION.
 *
 * A prospect's ability to open, question, accept and download an authorized
 * proposal is governed by the proposal's own access token and publication state,
 * not by the seller's billing position. That is why `proposalAccessPreserved()`
 * exists and always returns true: lapsed billing must never break a document a
 * third party has already been sent. What billing DOES govern is how much NEW
 * model spend the seller's account may incur — see `LAPSED_AI_ALLOWANCE_USD`.
 *
 * ---------------------------------------------------------------------------
 * NO PRICING LIVES IN THIS FILE.
 *
 * A plan carries limits, feature flags and the Stripe price ids it can be bought
 * through. It never carries an amount: the moment an amount exists in our code
 * there are two sources of truth for what a customer pays, and the local one will
 * eventually disagree with the charged one. Stripe owns every monetary value.
 * `priceNote` is display text and is documented as non-authoritative — never
 * parsed, never summed, never enforced.
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
   * DISPLAY ONLY. Shown next to the plan name so an operator can write "Contact
   * sales" for a negotiated pilot. Never parsed, summed or enforced.
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
 * Subscription status. Stripe's vocabulary verbatim, because the webhook writes it
 * straight through; keeping the same words means a support engineer comparing our
 * record to the Stripe dashboard is not translating between two enums.
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

// ------------------------------------------------------- administrative grant

/**
 * An explicit administrative grant.
 *
 * Two kinds, because they answer different questions:
 *
 *   'internal' — our own account and tenants that predate billing. Long-lived by
 *                design; an internal grant may omit `expiresAt` because the
 *                tenant is not on a clock, it is simply outside billing.
 *   'pilot'    — a time-boxed trial for a prospective customer. REQUIRES an
 *                expiry, because a pilot that can be created without an end date
 *                is how a free trial quietly becomes a permanent free plan.
 *
 * Both are platform_admin only and both are audited with the operator's uid, so
 * "who gave this customer access, and until when" is answerable months later.
 */
export const GrantKind = z.enum(['internal', 'pilot']);
export type GrantKind = z.infer<typeof GrantKind>;

export const PilotOverride = z
  .object({
    enabled: z.boolean().default(false),
    kind: GrantKind.default('pilot'),
    /** Grant a plan's limits wholesale, or… */
    planId: z.string().max(60).nullable().default(null),
    /** …override individual limits on top of whatever plan is granted. */
    limits: PlanLimits.partial().optional(),
    features: PlanFeatures.partial().optional(),
    expiresAt: z.date().nullable().default(null),
    note: z.string().max(1000).default(''),
  })
  .refine((v) => !v.enabled || v.kind === 'internal' || v.expiresAt instanceof Date, {
    message: 'A pilot grant must have an expiry date',
    path: ['expiresAt'],
  });
export type PilotOverride = z.infer<typeof PilotOverride>;

// ------------------------------------------------------------------- states

/**
 *   unentitled — nothing granted. DENIED. The safe default.
 *   granted    — an explicit internal or pilot grant is in force.
 *   active / trialing / grace / restricted — subscription-driven.
 */
export type EntitlementState = 'unentitled' | 'granted' | 'active' | 'trialing' | 'grace' | 'restricted';

export interface ResolvedEntitlements {
  state: EntitlementState;
  planId: string | null;
  planName: string | null;
  limits: PlanLimits;
  features: PlanFeatures;
  /** True when nothing has been granted and an operator must intervene. */
  needsPlan: boolean;
  /** Which kind of administrative grant is in force, when `state === 'granted'`. */
  grantKind: GrantKind | null;
  /** May the company create new users, proposals and documents? */
  canGrow: boolean;
  /** Days left in the grace window, or null outside it. */
  graceDaysRemaining: number | null;
  /** ISO date the grant or paid period ends, when known. */
  endsAt: string | null;
  cancelAtPeriodEnd: boolean;
  /** Machine-readable explanation for the dashboard, never shown to a prospect. */
  reasons: string[];
}

/**
 * Monthly AI allowance for an account that has lost its entitlement, in USD.
 *
 * THIS IS AN OPERATIONAL SAFETY CAP, NOT A PRICE. It exists to answer one
 * question: how much model spend may a lapsed account incur while a prospect is
 * still reading a proposal we already sent them? The answer has to be "a little,
 * not none and not unlimited":
 *
 *   - Not none, because cutting the assistant off mid-negotiation punishes the
 *     prospect for the seller's failed card, and destroys a deal that would have
 *     paid for a year of subscription.
 *   - Not unlimited, because an expired account must not be an unmetered API key.
 *
 * It is deliberately a constant rather than a plan field: a lapsed account may not
 * even have a resolvable plan, and this floor must still apply. It is also far
 * below any real plan's cap, so it can never be more generous than paying.
 */
export const LAPSED_AI_ALLOWANCE_USD = 2;

/** Nothing granted: no growth, and no model spend at all. */
const DENIED_LIMITS: PlanLimits = {
  maxUsers: 0,
  maxActiveProposals: 0,
  maxDocumentStorageMb: 0,
  aiMonthlyBudgetUsd: 0,
};

const DENIED_FEATURES: PlanFeatures = {
  documentIntelligence: false,
  companyIntelligence: false,
  customBranding: false,
  advancedAnalytics: false,
};

/**
 * Limits for an internal grant that names no plan.
 *
 * Growth is uncapped: these accounts are not what a paid plan protects against.
 * The AI ceiling is `null` — "no PLAN cap" — so `effectiveAiBudgetUsd` falls
 * through to the company's own configured setting, which is a finite number. An
 * internal grant therefore still cannot spend without limit; it is simply not
 * bounded by a plan it never bought.
 */
const INTERNAL_LIMITS: PlanLimits = {
  maxUsers: null,
  maxActiveProposals: null,
  maxDocumentStorageMb: null,
  aiMonthlyBudgetUsd: null,
};

const INTERNAL_FEATURES: PlanFeatures = {
  documentIntelligence: true,
  companyIntelligence: true,
  customBranding: true,
  advancedAnalytics: true,
};

/**
 * Fail-closed defaults when a subscription names a plan that cannot be resolved.
 *
 * Not a free tier — this is the state after a plan record was deleted or a price
 * became unknown. Growth is zeroed; the AI allowance is the lapsed floor so live
 * proposals keep answering. A resolver that fell back to unlimited here would turn
 * a data bug into a revenue leak.
 */
const UNKNOWN_PLAN_LIMITS: PlanLimits = {
  maxUsers: 0,
  maxActiveProposals: 0,
  maxDocumentStorageMb: 0,
  aiMonthlyBudgetUsd: LAPSED_AI_ALLOWANCE_USD,
};

const UNKNOWN_PLAN_FEATURES: PlanFeatures = {
  documentIntelligence: false,
  companyIntelligence: true,
  customBranding: false,
  advancedAnalytics: false,
};

/**
 * Limits once a paid subscription has actually lapsed.
 *
 * Growth zeroed; AI capped at the TIGHTER of the plan's own cap and the lapsed
 * floor, so a lapsed enterprise plan cannot keep its full allowance simply by
 * having once been large.
 */
function restrictedLimits(lapsedPlan: PlanLimits | null): PlanLimits {
  const planCap = lapsedPlan?.aiMonthlyBudgetUsd ?? null;
  return {
    maxUsers: 0,
    maxActiveProposals: 0,
    maxDocumentStorageMb: 0,
    aiMonthlyBudgetUsd: planCap === null ? LAPSED_AI_ALLOWANCE_USD : Math.min(planCap, LAPSED_AI_ALLOWANCE_USD),
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
  /** A plan granted by the administrative grant, when `override.planId` is set. */
  overridePlan?: PlanDefinition | null;
  override: PilotOverride | null;
  /** Injected so every lifecycle branch is testable without freezing time. */
  now: Date;
}

/**
 * Resolve what a company is entitled to right now.
 *
 * Order of precedence:
 *   1. An unexpired administrative grant — it exists precisely to place a tenant
 *      outside normal billing, so it beats whatever the subscription says.
 *   2. A subscription record, by status and dates.
 *   3. Nothing → `unentitled`, denied.
 */
export function resolveEntitlements(input: ResolveInput): ResolvedEntitlements {
  const { subscription, plan, override, now } = input;

  // ---- 1. administrative grant ----
  const grantLive =
    override?.enabled === true &&
    (override.expiresAt === null || override.expiresAt.getTime() > now.getTime());

  if (override?.enabled && grantLive) {
    const granted = input.overridePlan ?? plan;
    const baseLimits = granted?.limits ?? INTERNAL_LIMITS;
    const baseFeatures = granted?.features ?? INTERNAL_FEATURES;

    const limits: PlanLimits = { ...baseLimits, ...definedOnly(override.limits) };
    const features: PlanFeatures = { ...baseFeatures, ...definedOnly(override.features) };

    return {
      state: 'granted',
      planId: override.planId ?? granted?.id ?? null,
      planName: granted?.name ?? (override.kind === 'internal' ? 'Internal' : 'Pilot'),
      limits,
      features,
      needsPlan: false,
      grantKind: override.kind,
      canGrow: true,
      graceDaysRemaining: null,
      endsAt: override.expiresAt ? override.expiresAt.toISOString() : null,
      cancelAtPeriodEnd: false,
      reasons: [override.kind === 'internal' ? 'internal_grant_active' : 'pilot_grant_active'],
    };
  }

  // ---- 2. nothing at all: denied ----
  if (!subscription) {
    return {
      state: 'unentitled',
      planId: null,
      planName: null,
      limits: DENIED_LIMITS,
      features: DENIED_FEATURES,
      needsPlan: true,
      grantKind: null,
      canGrow: false,
      graceDaysRemaining: null,
      endsAt: null,
      cancelAtPeriodEnd: false,
      reasons: ['no_entitlement_granted'],
    };
  }

  const status = subscription.status;
  const periodEnd = subscription.currentPeriodEnd;
  const periodEnded = periodEnd !== null && periodEnd.getTime() <= now.getTime();

  // ---- 3. subscription-driven states ----
  switch (status) {
    case 'active': {
      if (periodEnded) return restrictedFor(subscription, plan, ['period_ended_without_renewal']);
      return grantState('active', subscription, plan, {
        endsAt: subscription.cancelAtPeriodEnd && periodEnd ? periodEnd.toISOString() : null,
        reasons: subscription.cancelAtPeriodEnd ? ['cancels_at_period_end'] : [],
      });
    }

    case 'trialing': {
      const trialEnd = subscription.trialEnd ?? periodEnd;
      if (trialEnd && trialEnd.getTime() <= now.getTime()) {
        return restrictedFor(subscription, plan, ['trial_expired']);
      }
      return grantState('trialing', subscription, plan, {
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
          ...grantState('grace', subscription, plan, {
            endsAt: graceEnds.toISOString(),
            reasons: ['payment_failed_within_grace'],
          }),
          graceDaysRemaining: remaining,
        };
      }
      return restrictedFor(subscription, plan, ['grace_period_expired']);
    }

    case 'canceled': {
      // Stripe keeps a subscription "active" until period end when cancel-at-period-
      // end is set; a `canceled` status with a FUTURE period means paid-through
      // access, with a past period means it simply lapsed.
      if (periodEnd && periodEnd.getTime() > now.getTime()) {
        return grantState('active', subscription, plan, {
          endsAt: periodEnd.toISOString(),
          reasons: ['paid_through_period_after_cancellation'],
        });
      }
      return restrictedFor(subscription, plan, ['subscription_canceled']);
    }

    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    case 'paused':
    case 'expired':
    default:
      return restrictedFor(subscription, plan, [`status_${status}`]);
  }
}

/** Drop keys whose value is `undefined`, so a partial grant cannot blank a limit. */
function definedOnly<T extends Record<string, unknown>>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function grantState(
  state: Extract<EntitlementState, 'active' | 'trialing' | 'grace'>,
  subscription: SubscriptionRecord,
  plan: PlanDefinition | null,
  extra: { endsAt: string | null; reasons: string[] },
): ResolvedEntitlements {
  return {
    state,
    planId: subscription.planId ?? plan?.id ?? null,
    planName: plan?.name ?? null,
    limits: plan?.limits ?? UNKNOWN_PLAN_LIMITS,
    features: plan?.features ?? UNKNOWN_PLAN_FEATURES,
    needsPlan: false,
    grantKind: null,
    canGrow: true,
    graceDaysRemaining: null,
    endsAt: extra.endsAt,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    reasons: plan !== null ? extra.reasons : [...extra.reasons, 'plan_unresolved'],
  };
}

function restrictedFor(
  subscription: SubscriptionRecord,
  plan: PlanDefinition | null,
  reasons: string[],
): ResolvedEntitlements {
  return {
    state: 'restricted',
    planId: subscription.planId ?? plan?.id ?? null,
    planName: plan?.name ?? null,
    limits: restrictedLimits(plan?.limits ?? null),
    features: {
      documentIntelligence: false,
      companyIntelligence: true,
      customBranding: plan?.features.customBranding ?? false,
      advancedAnalytics: false,
    },
    needsPlan: false,
    grantKind: null,
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
  | 'no_entitlement'
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

/** The refusal used whenever an account has nothing granted. */
function noEntitlement(what: string): EntitlementDecision {
  return {
    allowed: false,
    code: 'no_entitlement',
    message: `This account has no active plan, so ${what} is unavailable. Contact us to activate access.`,
  };
}

/** Adding a seat. `currentUsers` must include the admin and any pending invites. */
export function checkCanAddUser(ent: ResolvedEntitlements, currentUsers: number): EntitlementDecision {
  if (ent.state === 'unentitled') return noEntitlement('adding team members');
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
  if (ent.state === 'unentitled') return noEntitlement('creating proposals');
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
  if (ent.state === 'unentitled') return noEntitlement('uploading documents');
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
  if (ent.state === 'unentitled') return noEntitlement(FEATURE_LABELS[feature].toLowerCase());
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
 * THE TIGHTER OF THE TWO, the same principle as Phase One's commercial authority:
 * a plan may lower the allowance a company configured for itself, but a company
 * setting may never raise itself above what it bought. Getting this backwards
 * would let an admin type `aiBudgetUsd: 100000` into the company document and
 * silently override the plan.
 *
 * An unentitled company resolves to a plan cap of 0, so it cannot spend at all
 * regardless of what its own settings claim — the default-deny rule reaching all
 * the way down to the model call.
 */
export function effectiveAiBudgetUsd(
  ent: ResolvedEntitlements,
  companySettingUsd: number | null | undefined,
): number | null {
  const planCap = ent.limits.aiMonthlyBudgetUsd;
  const companyCap =
    typeof companySettingUsd === 'number' && Number.isFinite(companySettingUsd) ? companySettingUsd : null;

  if (planCap === null && companyCap === null) return null;
  if (planCap === null) return companyCap;
  if (companyCap === null) return planCap;
  return Math.min(planCap, companyCap);
}

/**
 * Whether the month's allowance is spent.
 *
 * `companyBudgetUsd` is the caller's company-level setting, ALREADY defaulted to
 * the platform fallback when unset — that defaulting belongs to the caller because
 * the fallback is an operational constant, not an entitlement rule.
 */
export function checkAiBudget(
  ent: ResolvedEntitlements,
  spentMicroUsd: number,
  companyBudgetUsd: number | null | undefined,
): EntitlementDecision {
  const budget = effectiveAiBudgetUsd(ent, companyBudgetUsd);
  // A zero budget means every request is already at the ceiling, including an
  // unentitled account that has spent nothing.
  if (budget === null) return OK;
  if (budget <= 0 || spentMicroUsd >= budget * 1_000_000) {
    if (ent.state === 'unentitled') {
      return {
        allowed: false,
        code: 'no_entitlement',
        message: 'This account has no active plan, so the assistant is unavailable.',
      };
    }
    return {
      allowed: false,
      code: 'ai_budget_exceeded',
      message: 'The monthly AI allowance for this account has been reached.',
    };
  }
  return OK;
}

// -------------------------------------------------- existing-proposal access

/**
 * Whether an already-published proposal may still be opened, questioned, accepted
 * and downloaded.
 *
 * ALWAYS TRUE, deliberately, and this function exists so that the rule is stated
 * once and cannot be "optimised" into a billing check by a later change.
 *
 * A proposal is a document we have already sent a third party. The seller's failed
 * card, cancelled plan or expired pilot is not the prospect's problem, and pulling
 * a live commercial document mid-negotiation would be both commercially damaging
 * and, for a document already signed, potentially a legal problem. Billing governs
 * NEW work and NEW spend; it does not reach backwards into a link already issued.
 *
 * The signature takes the entitlements so callers read naturally, and ignores them
 * so nothing can accidentally start gating on it.
 */
export function proposalAccessPreserved(_ent: ResolvedEntitlements): true {
  return true;
}

// ------------------------------------------------------------------- helpers

/**
 * Find the plan that grants a Stripe price.
 *
 * An inactive plan still matches: an existing subscriber on a retired plan keeps
 * what they bought. Retiring a plan stops new purchases, it does not evict
 * current customers.
 */
export function planForPriceId(
  plans: PlanDefinition[],
  priceId: string | null | undefined,
): PlanDefinition | null {
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

/** A short, staff-facing summary of the billing position. */
export function describeEntitlements(ent: ResolvedEntitlements): string {
  switch (ent.state) {
    case 'unentitled':
      return 'No plan — access not granted';
    case 'granted':
      return `${ent.grantKind === 'internal' ? 'Internal access' : 'Pilot'} — ${ent.planName ?? 'granted'}`;
    case 'active':
      return ent.cancelAtPeriodEnd
        ? `${ent.planName ?? 'Active'} — cancels at period end`
        : ent.planName ?? 'Active';
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
