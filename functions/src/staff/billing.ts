/**
 * Subscription and entitlement callables.
 *
 * Four responsibilities, with deliberately different audiences:
 *
 *   listPlans / getCompanyEntitlements   — readable by any staff role, because a
 *       sales rep needs to know whether they can create another proposal, and the
 *       dashboard needs to show a billing banner before an admin hits a wall.
 *
 *   createPlan / updatePlan              — platform_admin only. The plan catalogue
 *       is cross-tenant: one operator defines what every customer can buy, so a
 *       company admin must never be able to grant themselves a bigger plan.
 *
 *   setEntitlementOverride / clear...     — platform_admin only. A pilot grant is
 *       a commercial decision made about a tenant by the operator, and it must
 *       expire (enforced in the schema, not just the UI).
 *
 * WHY THE PLAN CATALOGUE IS NOT TENANT-SCOPED, AND WHY THAT IS SAFE HERE
 * A company_admin can read their own entitlement but cannot write any plan or
 * override. The only way a tenant's limits change is Stripe (a purchase) or a
 * platform_admin (a pilot). There is no call a company_admin can make that
 * increases their own ceiling — which is the property that makes a shared,
 * non-tenant-scoped catalogue safe.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db, COLLECTIONS, FieldValue } from '../lib/firebase.js';
import { requireStaff, requirePlatformAdmin } from './auth.js';
import { audit } from '../lib/audit.js';
import { PlanDefinition, PilotOverride, describeEntitlements, sortPlans } from '../lib/entitlements.js';
import { loadPlans, resolveCompanyEntitlements, countCompanyUsers, countActiveProposals, totalDocumentMb } from '../lib/entitlementStore.js';

const REGION = 'us-central1';

// -------------------------------------------------------------------- reading

/**
 * The plan catalogue, for the pricing UI and the dashboard.
 * Any signed-in staff member may read it: it is a price list, not a secret.
 */
export const listPlans = onCall({ region: REGION }, async (request) => {
  requireStaff(request);
  const plans = await loadPlans();
  return {
    plans: sortPlans(plans).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      limits: p.limits,
      features: p.features,
      priceNote: p.priceNote,
      active: p.active,
      sortOrder: p.sortOrder,
      // The Stripe price ids are returned because the dashboard must pass one to
      // createCheckoutSession. They are public identifiers, not secrets — the
      // amount and the secret key both live in Stripe.
      stripePriceIds: p.stripePriceIds,
    })),
  };
});

/**
 * The caller's own entitlement position, with current usage filled in.
 *
 * Usage is returned alongside limits because "3 of 5 users" is the answer an
 * admin actually needs; returning only the limit forces the dashboard to make a
 * second call and compute the ratio itself, which is where off-by-one bugs live.
 */
export const getCompanyEntitlements = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const companyId = identity.companyId;

  const [ent, users, activeProposals, documentMb, companySnap] = await Promise.all([
    resolveCompanyEntitlements(companyId),
    countCompanyUsers(companyId),
    countActiveProposals(companyId),
    totalDocumentMb(companyId),
    db.collection(COLLECTIONS.companies).doc(companyId).get(),
  ]);

  const companySettings = (companySnap.data() as { settings?: { aiBudgetUsd?: number } } | undefined)?.settings;

  return {
    companyId,
    state: ent.state,
    status: describeEntitlements(ent),
    planId: ent.planId,
    planName: ent.planName,
    limits: ent.limits,
    features: ent.features,
    canGrow: ent.canGrow,
    grandfathered: ent.grandfathered,
    graceDaysRemaining: ent.graceDaysRemaining,
    endsAt: ent.endsAt,
    cancelAtPeriodEnd: ent.cancelAtPeriodEnd,
    reasons: ent.reasons,
    usage: {
      users,
      activeProposals,
      documentMb,
      /** The company-level AI setting, for display; the effective cap may be lower. */
      aiBudgetUsd: companySettings?.aiBudgetUsd ?? null,
    },
    /** UI gating only — the server re-checks on every write. */
    canManageBilling: identity.role === 'company_admin',
  };
});

// ------------------------------------------------------------------- writing

/** Fields a plan may be created with. `id` is chosen on create and immutable. */
const PlanPayload = z.object({
  id: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use a lowercase slug like "growth"'),
  name: z.string().min(1).max(80),
  description: z.string().max(600).optional(),
  stripePriceIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  limits: z.object({
    maxUsers: z.number().int().min(0).nullable(),
    maxActiveProposals: z.number().int().min(0).nullable(),
    maxDocumentStorageMb: z.number().int().min(0).nullable(),
    aiMonthlyBudgetUsd: z.number().min(0).nullable(),
  }),
  features: z.object({
    documentIntelligence: z.boolean(),
    companyIntelligence: z.boolean(),
    customBranding: z.boolean(),
    advancedAnalytics: z.boolean(),
  }),
  priceNote: z.string().max(80).optional(),
  gracePeriodDays: z.number().int().min(0).max(90).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const createPlan = onCall({ region: REGION }, async (request) => {
  const identity = requirePlatformAdmin(request);

  const parsed = PlanPayload.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid plan');
  }

  const ref = db.collection(COLLECTIONS.plans).doc(parsed.data.id);
  const existing = await ref.get();
  if (existing.exists) throw new HttpsError('already-exists', 'A plan with that id already exists');

  const plan = PlanDefinition.parse({
    ...parsed.data,
    // Display-only string; the real amount lives in Stripe's price object.
    priceNote: parsed.data.priceNote ?? '',
    gracePeriodDays: parsed.data.gracePeriodDays ?? 7,
    active: parsed.data.active ?? true,
    sortOrder: parsed.data.sortOrder ?? 0,
  });

  await ref.set({
    ...plan,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: identity.uid,
  });

  await audit({
    companyId: '',
    action: 'plan.created',
    actorType: 'system',
    actorId: identity.uid,
    detail: { planId: plan.id, limits: plan.limits },
  });

  return { id: plan.id };
});

/**
 * Update an existing plan.
 *
 * `id` is NOT changeable: subscriptions store it, so renaming a plan id would
 * orphan every subscriber on it. Retire a plan with `active: false` instead —
 * that stops new purchases while existing subscribers keep their entitlements
 * (see `planForPriceId` in the pure module).
 */
export const updatePlan = onCall({ region: REGION }, async (request) => {
  const identity = requirePlatformAdmin(request);

  const input = z.object({ id: z.string().min(1).max(60) }).passthrough().safeParse(request.data);
  if (!input.success) throw new HttpsError('invalid-argument', 'Missing plan id');

  const ref = db.collection(COLLECTIONS.plans).doc(input.data.id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Plan not found');

  // Merge over the stored record so a partial update cannot blank a limit that
  // the operator did not resend — the same partial-patch trap as Phase One's
  // intelligence save.
  const merged = { ...(snap.data() as Record<string, unknown>), ...(request.data as Record<string, unknown>) };
  // `id` always comes from the path, never from the payload.
  merged.id = input.data.id;

  const parsed = PlanDefinition.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpsError('invalid-argument', `${issue?.path.join('.') || 'plan'}: ${issue?.message ?? 'invalid'}`);
  }

  await ref.set(
    {
      ...parsed.data,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: identity.uid,
    },
    { merge: false },
  );

  await audit({
    companyId: '',
    action: parsed.data.active ? 'plan.updated' : 'plan.deactivated',
    actorType: 'system',
    actorId: identity.uid,
    detail: { planId: parsed.data.id, active: parsed.data.active, limits: parsed.data.limits },
  });

  return { ok: true };
});

// ------------------------------------------------------------ pilot overrides

/**
 * Grant or replace a pilot override for one company.
 *
 * `expiresAt` is REQUIRED by the schema when `enabled` is true, so an operator
 * cannot create an open-ended grant. The date is stored as a Firestore Timestamp
 * and re-checked at read time by the resolver, so an expired grant stops working
 * even if nobody remembers to clear it.
 */
export const setEntitlementOverride = onCall({ region: REGION }, async (request) => {
  const identity = requirePlatformAdmin(request);

  const parsed = z
    .object({
      companyId: z.string().min(1).max(200),
      planId: z.string().max(60).nullable().optional(),
      limits: z
        .object({
          maxUsers: z.number().int().min(0).nullable().optional(),
          maxActiveProposals: z.number().int().min(0).nullable().optional(),
          maxDocumentStorageMb: z.number().int().min(0).nullable().optional(),
          aiMonthlyBudgetUsd: z.number().min(0).nullable().optional(),
        })
        .optional(),
      features: z
        .object({
          documentIntelligence: z.boolean().optional(),
          companyIntelligence: z.boolean().optional(),
          customBranding: z.boolean().optional(),
          advancedAnalytics: z.boolean().optional(),
        })
        .optional(),
      expiresAt: z.string().datetime({ offset: true }).or(z.string().min(8)),
      note: z.string().max(1000).optional(),
    })
    .safeParse(request.data);

  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid override');
  }

  const companySnap = await db.collection(COLLECTIONS.companies).doc(parsed.data.companyId).get();
  if (!companySnap.exists) throw new HttpsError('not-found', 'Company not found');

  const expiresAt = new Date(parsed.data.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new HttpsError('invalid-argument', 'Expiry must be a valid date');
  }
  if (expiresAt.getTime() <= Date.now()) {
    // An already-expired grant is a no-op that would silently grant nothing while
    // the dashboard shows "Pilot". Refuse it so the operator notices.
    throw new HttpsError('invalid-argument', 'Expiry must be in the future');
  }

  // Validate the whole override through the same schema the resolver uses, so a
  // grant that passes here cannot fail to apply later.
  const candidate = PilotOverride.safeParse({
    enabled: true,
    planId: parsed.data.planId ?? null,
    limits: parsed.data.limits,
    features: parsed.data.features,
    expiresAt,
    note: parsed.data.note ?? '',
  });
  if (!candidate.success) {
    throw new HttpsError('invalid-argument', candidate.error.issues[0]?.message ?? 'Invalid override');
  }

  await db
    .collection(COLLECTIONS.entitlementOverrides)
    .doc(parsed.data.companyId)
    .set(
      {
        companyId: parsed.data.companyId,
        enabled: true,
        planId: candidate.data.planId,
        limits: candidate.data.limits ?? {},
        features: candidate.data.features ?? {},
        expiresAt,
        note: candidate.data.note,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: identity.uid,
      },
      { merge: false },
    );

  await audit({
    companyId: parsed.data.companyId,
    action: 'entitlement.override_set',
    actorType: 'system',
    actorId: identity.uid,
    detail: {
      planId: candidate.data.planId,
      limits: candidate.data.limits ?? {},
      expiresAt: expiresAt.toISOString(),
      note: candidate.data.note,
    },
  });

  return { ok: true, expiresAt: expiresAt.toISOString() };
});

/** Remove a pilot override, returning the company to its subscription state. */
export const clearEntitlementOverride = onCall({ region: REGION }, async (request) => {
  const identity = requirePlatformAdmin(request);

  const parsed = z.object({ companyId: z.string().min(1).max(200) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing company id');

  const ref = db.collection(COLLECTIONS.entitlementOverrides).doc(parsed.data.companyId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: true, cleared: false };

  await ref.delete();

  await audit({
    companyId: parsed.data.companyId,
    action: 'entitlement.override_cleared',
    actorType: 'system',
    actorId: identity.uid,
  });

  return { ok: true, cleared: true };
});
