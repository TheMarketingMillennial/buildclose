/**
 * Company intelligence callables.
 *
 * Two callables, because the two records have different audiences and different
 * risk profiles:
 *
 *   getCompanyIntelligence / updateCompanyIntelligence
 *     Knowledge. Readable by every staff role, because a rep needs to know what
 *     the house voice and approved answers are. Writable only by CONFIG_ROLES.
 *
 *   getCompanyAuthority / updateCompanyAuthority
 *     Commercial authority. Readable only by CONFIG_ROLES — a sales_rep must not
 *     be able to read the price floor, because the floor is the one number the
 *     whole negotiation turns on. Writable only by CONFIG_ROLES, and never by a
 *     rep.
 *
 * Neither can be written by a caller who supplies their own companyId: the
 * tenant always comes from the verified token claim.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db, COLLECTIONS, FieldValue } from '../lib/firebase.js';
import { requireStaff, requireRole, CONFIG_ROLES } from './auth.js';
import { audit } from '../lib/audit.js';
import {
  CompanyIntelligenceInput,
  CommercialAuthorityInput,
  validateAuthority,
  deepMerge,
} from '../lib/company.js';

const REGION = 'us-central1';

/** Document id is the company id: one intelligence record per tenant, by construction. */
function docFor(collection: string, companyId: string) {
  return db.collection(collection).doc(companyId);
}

// ------------------------------------------------------------- intelligence read

export const getCompanyIntelligence = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);

  const snap = await docFor(COLLECTIONS.companyIntelligence, identity.companyId).get();
  // Always return a valid shape, so the dashboard renders an empty form rather
  // than having to defend against null on every field.
  const data = snap.exists ? CompanyIntelligenceInput.safeParse(snap.data()) : null;
  const value = data?.success ? data.data : CompanyIntelligenceInput.parse({});

  return {
    intelligence: value,
    /** Whether the record exists yet — distinguishes "never set up" from "blank". */
    configured: snap.exists,
    /** UI gating only; the server re-checks the role on every write. */
    canEdit: identity.role === 'platform_admin' || CONFIG_ROLES.includes(identity.role),
    updatedAt: (snap.data() as { updatedAt?: { toMillis?: () => number } } | undefined)?.updatedAt?.toMillis?.() ?? null,
  };
});

// ------------------------------------------------------------ intelligence write

/**
 * Known top-level sections. Anything else is rejected rather than merged, so a
 * caller cannot introduce stray keys into the stored record.
 */
const SECTIONS = [
  'profile',
  'productsServices',
  'salesMethodology',
  'brandVoice',
  'objectionPlaybook',
  'faqs',
  'commercialPolicies',
  'assistantDefaults',
] as const;

export const updateCompanyIntelligence = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, CONFIG_ROLES);

  /**
   * The patch is validated as LOOSE, not against the section schemas.
   *
   * This ordering is deliberate and was a genuine defect in the first draft.
   * Parsing the patch with the real schema applies every nested `.default()`, so
   * a payload of `{ profile: { displayName: 'Acme' } }` comes back as a complete
   * profile with `description: ''`, `differentiators: []` and so on. Merging that
   * over the stored record then blanks every field the manager did not resend —
   * the edit appears to work while quietly destroying their profile.
   *
   * So the patch is only checked for shape and known keys, merged raw over what
   * is stored, and the RESULT is validated against the full schema. Defaults then
   * only ever fill keys that were never set anywhere.
   */
  const raw = request.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpsError('invalid-argument', 'Expected an object of sections to update');
  }
  const patch = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(patch).filter((k) => !(SECTIONS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    throw new HttpsError('invalid-argument', `Unknown section(s): ${unknownKeys.join(', ')}`);
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpsError('invalid-argument', 'Nothing to update');
  }

  const ref = docFor(COLLECTIONS.companyIntelligence, identity.companyId);
  const existing = await ref.get();

  const stored = existing.exists ? (existing.data() as Record<string, unknown>) : {};
  const merged = deepMerge(stored, patch);

  /**
   * Objection entries default `escalate: true`. An entry supplied without that
   * flag must NOT be inferred as "the assistant may answer this" — it escalates
   * until a human says otherwise. Applied after the merge so it also covers
   * entries added by this write.
   */
  if (Array.isArray(merged.objectionPlaybook)) {
    merged.objectionPlaybook = (merged.objectionPlaybook as unknown[]).map((o) => {
      const entry = (o ?? {}) as Record<string, unknown>;
      const escalate = typeof entry.escalate === 'boolean' ? entry.escalate : true;
      return { ...entry, escalate };
    });
  }

  const validated = CompanyIntelligenceInput.safeParse(merged);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const where = issue?.path.join('.') || 'payload';
    throw new HttpsError('invalid-argument', `${where}: ${issue?.message ?? 'invalid'}`);
  }

  await ref.set(
    {
      ...validated.data,
      companyId: identity.companyId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: identity.uid,
      // First write records creation separately so "since when" survives edits.
      ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: false },
  );

  await audit({
    companyId: identity.companyId,
    action: 'company.intelligence_updated',
    actorType: 'staff',
    actorId: identity.uid,
    // Section names only — never the content, which can contain commercial detail.
    detail: { sections: Object.keys(patch) },
  });

  return { ok: true, sections: Object.keys(patch) };
});

// ---------------------------------------------------------------- authority read

export const getCompanyAuthority = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  /**
   * Reps are refused, not shown a redacted view.
   *
   * A redacted authority record would still confirm the shape of the policy —
   * whether a floor exists at all — and the floor is precisely the number a rep
   * might be tempted to probe for. Refusing outright keeps the boundary legible.
   */
  requireRole(identity, CONFIG_ROLES);

  const snap = await docFor(COLLECTIONS.companyAuthority, identity.companyId).get();
  const parsed = snap.exists ? CommercialAuthorityInput.safeParse(snap.data()) : null;

  return {
    authority: parsed?.success ? parsed.data : null,
    configured: Boolean(parsed?.success),
    updatedAt: (snap.data() as { updatedAt?: { toMillis?: () => number } } | undefined)?.updatedAt?.toMillis?.() ?? null,
  };
});

// --------------------------------------------------------------- authority write

export const updateCompanyAuthority = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, CONFIG_ROLES);

  /**
   * The authority record is replaced whole, not patched.
   *
   * A partial patch on a discount ceiling is how "set the ceiling to 15%" becomes
   * "ceiling 15% but permissions left from before". Requiring the complete object
   * means every write is a conscious statement of the full policy, and the
   * semantic checks below always run against a coherent whole.
   */
  const parsed = CommercialAuthorityInput.safeParse(request.data?.authority ?? request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid authority payload');
  }

  const problems = validateAuthority(parsed.data);
  if (problems.length > 0) {
    throw new HttpsError('invalid-argument', problems.join(' '));
  }

  /**
   * Cross-check: a floor above zero with a discount ceiling that could breach it
   * is contradictory, and would make the assistant refuse everything. Detected
   * here so a manager sees it at configuration time, not mid-negotiation.
   */
  if (
    parsed.data.priceFloorMinor > 0 &&
    parsed.data.maxDiscountPercent > 0 &&
    parsed.data.approvedDiscounts.some((d) => d.amountMinor > 0 && d.amountMinor < parsed.data.priceFloorMinor)
  ) {
    // Legal but almost certainly unintended: an approved concession that is below
    // the floor can never be offered, so it is a dead entry the assistant will
    // silently never use.
    // Recorded rather than rejected, because a staged rollout may set the floor
    // before retiring old concessions.
    await audit({
      companyId: identity.companyId,
      action: 'company.authority_updated',
      actorType: 'staff',
      actorId: identity.uid,
      detail: { warning: 'approved_discount_below_floor' },
    });
  }

  const ref = docFor(COLLECTIONS.companyAuthority, identity.companyId);
  const existing = await ref.get();

  await ref.set(
    {
      ...parsed.data,
      companyId: identity.companyId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: identity.uid,
      ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: false },
  );

  await audit({
    companyId: identity.companyId,
    action: 'company.authority_updated',
    actorType: 'staff',
    actorId: identity.uid,
    /**
     * The numbers ARE recorded, because the audit trail's job is to answer "who
     * authorised this ceiling". The audit log is staff-only and already gated to
     * managers and above by getAuditLog.
     */
    detail: {
      priceFloorMinor: parsed.data.priceFloorMinor,
      maxDiscountPercent: parsed.data.maxDiscountPercent,
      canOfferDiscounts: parsed.data.negotiationPermissions.canOfferDiscounts,
    },
  });

  return { ok: true };
});
