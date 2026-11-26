/**
 * Entitlement resolution against Firestore.
 *
 * The pure rules live in `entitlements.ts`; this module is the thin I/O layer
 * that loads the three records those rules need and hands them over. It exists
 * so that every enforcement point — proposal creation, seat invites, document
 * upload, the AI budget check — resolves entitlement through ONE code path.
 *
 * Why that matters more than it looks: an enforcement point that inlined its own
 * lookup would eventually disagree with the others. One caller reading
 * `subscriptions/{id}.status === 'active'` while another used the resolver would
 * mean a company in good standing with a `trialing` subscription could create
 * proposals but not invite a user, and the bug would only surface in production
 * for a customer on a trial. Single chokepoint, same guarantee as Phase One's
 * `resolveProspectContext`.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY.
 *
 * A Firestore read failure here does NOT lock the customer out. If the plans
 * collection is momentarily unavailable, throwing would block a paying customer
 * from creating a proposal — a self-inflicted outage. Instead a read failure
 * degrades to "grandfathered" (`unsubscribed`), which is the pre-billing
 * behaviour every existing tenant already has. The trade-off is explicit: a
 * billing outage can under-meter, never over-block. Under-metering is a billable
 * conversation with a customer; over-blocking is a lost deal at 2am. The AI
 * budget has its own separate ceiling, so this cannot become an unbounded spend.
 *
 * The console token bucket is deliberately NOT consulted here — that is a
 * rate-limit concern, not an entitlement one.
 */
import { db, COLLECTIONS } from './firebase.js';
import {
  PlanDefinition,
  PilotOverride,
  SubscriptionStatus,
  resolveEntitlements,
  type SubscriptionRecord,
  type ResolvedEntitlements,
} from './entitlements.js';

/** Firestore Timestamp | Date | ISO string | null → Date | null. */
function asDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const d = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Load the plan catalogue.
 *
 * Small and read on nearly every staff write, but the emulator and production
 * alike return it in one round trip; caching it would mean a plan edit takes
 * effect only after a cold start, which is precisely the behaviour an operator
 * changing limits would not expect.
 */
export async function loadPlans(): Promise<PlanDefinition[]> {
  const snap = await db.collection(COLLECTIONS.plans).limit(100).get();
  const out: PlanDefinition[] = [];
  for (const doc of snap.docs) {
    const parsed = PlanDefinition.safeParse({ ...doc.data(), id: doc.id });
    // A malformed plan is skipped, not fatal: one bad row must not stop every
    // tenant from resolving entitlement.
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Resolve what a company is entitled to right now.
 *
 * `now` is injectable so the emulator-backed suite can move a period end into the
 * past without waiting, and so a caller reasoning about a future date (a billing
 * preview) can ask the same question.
 */
export async function resolveCompanyEntitlements(
  companyId: string,
  now: Date = new Date(),
): Promise<ResolvedEntitlements> {
  try {
    const [subSnap, overrideSnap, plans] = await Promise.all([
      db.collection(COLLECTIONS.subscriptions).doc(companyId).get(),
      db.collection(COLLECTIONS.entitlementOverrides).doc(companyId).get(),
      loadPlans(),
    ]);

    // ---- subscription ----
    let subscription = null as null | {
      companyId: string;
      status: (typeof SubscriptionStatus)['_output'];
      planId: string | null;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      priceId: string | null;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
      trialEnd: Date | null;
    };

    if (subSnap.exists) {
      const d = subSnap.data() as Record<string, unknown>;
      const statusParsed = SubscriptionStatus.safeParse(d.status);
      /**
       * An unrecognised status is treated as `expired` (restricted), not skipped.
       *
       * A status we do not understand means Stripe has told us something this
       * code predates. Defaulting to entitlements would keep giving away a plan
       * indefinitely after a Stripe API version bump; defaulting to restricted is
       * recoverable in one support action and visible in the dashboard.
       */
      const status = statusParsed.success ? statusParsed.data : ('expired' as const);
      const priceId = typeof d.priceId === 'string' ? d.priceId : null;

      // Re-resolve the plan from the price when the stored planId is absent or
      // stale (a price moved between plans after the fact).
      const planIdFromPrice = priceId ? plans.find((p) => p.stripePriceIds.includes(priceId))?.id ?? null : null;

      subscription = {
        companyId,
        status,
        planId: (typeof d.planId === 'string' ? d.planId : null) ?? planIdFromPrice,
        stripeCustomerId: typeof d.stripeCustomerId === 'string' ? d.stripeCustomerId : null,
        stripeSubscriptionId: typeof d.stripeSubscriptionId === 'string' ? d.stripeSubscriptionId : null,
        priceId,
        currentPeriodEnd: asDate(d.currentPeriodEnd),
        cancelAtPeriodEnd: d.cancelAtPeriodEnd === true,
        trialEnd: asDate(d.trialEnd),
      };
    }

    // ---- pilot override ----
    let override = null as PilotOverride | null;
    if (overrideSnap.exists) {
      const d = overrideSnap.data() as Record<string, unknown>;
      const parsed = PilotOverride.safeParse({
        enabled: d.enabled === true,
        planId: typeof d.planId === 'string' ? d.planId : null,
        limits: d.limits ?? undefined,
        features: d.features ?? undefined,
        // A Firestore timestamp cannot satisfy the Zod date refinement unless it
        // is converted first; this is why the conversion happens here and not in
        // the pure module.
        expiresAt: asDate(d.expiresAt),
        note: typeof d.note === 'string' ? d.note : '',
      });
      // A malformed override is IGNORED, not applied partially: an override that
      // grants some limits and silently drops others is worse than none.
      if (parsed.success) override = parsed.data;
    }

    // ---- plan lookup ----
    const planId = override?.planId ?? subscription?.planId ?? null;
    const plan = planId ? plans.find((p) => p.id === planId) ?? null : null;

    return resolveEntitlements({
      subscription: subscription as never,
      plan,
      override,
      overridePlan: plan,
      now,
    });
  } catch (err) {
    /**
     * Degrade to grandfathered rather than blocking. See the module header for
     * why this direction is the safe one.
     */
    console.error('[entitlements] resolution failed, degrading to grandfathered', (err as Error).message);
    return resolveEntitlements({ subscription: null, plan: null, override: null, now });
  }
}

/** Count the seats a company already occupies, for the user limit. */
export async function countCompanyUsers(companyId: string): Promise<number> {
  const snap = await db
    .collection(COLLECTIONS.users)
    .where('companyId', '==', companyId)
    .limit(1000)
    .get();
  // Disabled accounts still occupy a seat: the licence is per named user, and a
  // suspended user who can be re-enabled without a new seat is what a customer
  // expects. Counting only `active` would let a company cycle seats forever.
  return snap.size;
}

/** Count active (draft or published) proposals, for the proposal limit. */
export async function countActiveProposals(companyId: string): Promise<number> {
  const [drafts, published] = await Promise.all([
    db.collection(COLLECTIONS.proposals).where('companyId', '==', companyId).where('status', '==', 'draft').limit(1000).get(),
    db.collection(COLLECTIONS.proposals).where('companyId', '==', companyId).where('status', '==', 'published').limit(1000).get(),
  ]);
  // Archived proposals are excluded: they are finished work, and charging a
  // customer's quota for last quarter's archive is how a limit feels punitive.
  return drafts.size + published.size;
}

/**
 * Total document storage a company already uses, in megabytes.
 *
 * Rounded UP, so a company sitting at 199.4 MB of a 200 MB plan is treated as
 * full rather than squeezing in one more 0.5 MB file. Storage limits that round
 * down are a support ticket in waiting.
 */
export async function totalDocumentMb(companyId: string): Promise<number> {
  const snap = await db
    .collection(COLLECTIONS.documents)
    .where('companyId', '==', companyId)
    .limit(1000)
    .get();

  let bytes = 0;
  for (const doc of snap.docs) {
    const size = Number((doc.data() as { sizeBytes?: number }).sizeBytes ?? 0);
    if (Number.isFinite(size) && size > 0) bytes += size;
  }
  return Math.ceil(bytes / (1024 * 1024));
}
