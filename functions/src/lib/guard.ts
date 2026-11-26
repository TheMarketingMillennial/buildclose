/**
 * Server-side entitlement enforcement.
 *
 * Every staff write that consumes a plan allowance calls one of these. They exist
 * so that enforcement is a single, auditable choke point rather than a condition
 * duplicated in each callable — the same discipline as `resolveProspectContext`
 * for prospect reads and `effectiveAuthority` for commercial authority.
 *
 * ---------------------------------------------------------------------------
 * WHY GUARDS, NOT DECORATORS, AND WHY THEY THROW `HttpsError`.
 *
 * A callable's contract with the dashboard is an `HttpsError` with a code the UI
 * can branch on. `resource-exhausted` is the correct code for a limit, and
 * `failed-precondition` for a lapsed subscription, because the client's remedy
 * differs: one needs an upgrade, the other needs a payment. Returning a soft
 * `{ok: false}` from a guard would mean every caller had to remember to check it,
 * and the first caller that forgot would silently create the proposal anyway.
 *
 * ---------------------------------------------------------------------------
 * EVERY BLOCK IS AUDITED.
 *
 * A customer who says "it stopped letting me add users" should be answerable from
 * the trail, and a support engineer should be able to tell a plan limit apart from
 * a bug without reproducing it. The audit entry records the code, the limit and
 * current usage — never the payload that was refused, in case it contained
 * commercial detail.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { audit } from './audit.js';
import {
  checkCanAddUser,
  checkCanCreateProposal,
  checkCanStoreDocuments,
  checkFeature,
  type EntitlementDecision,
  type FeatureKey,
  type ResolvedEntitlements,
} from './entitlements.js';
import { resolveCompanyEntitlements, countCompanyUsers, countActiveProposals, totalDocumentMb } from './entitlementStore.js';

/** Map an entitlement code onto the HttpsError code the dashboard branches on. */
function httpCodeFor(decision: EntitlementDecision): ConstructorParameters<typeof HttpsError>[0] {
  switch (decision.code) {
    case 'plan_limit_reached':
      return 'resource-exhausted';
    case 'subscription_inactive':
    case 'feature_not_in_plan':
      return 'failed-precondition';
    case 'ai_budget_exceeded':
      return 'resource-exhausted';
    default:
      return 'failed-precondition';
  }
}

/** Throw, and record why, when a decision denies the action. */
async function enforce(
  companyId: string,
  actorUid: string,
  action: string,
  decision: EntitlementDecision,
): Promise<void> {
  if (decision.allowed) return;

  await audit({
    companyId,
    action: 'entitlement.blocked',
    actorType: 'staff',
    actorId: actorUid,
    detail: {
      attempted: action,
      code: decision.code,
      ...(decision.limit !== undefined ? { limit: decision.limit } : {}),
      ...(decision.use !== undefined ? { use: decision.use } : {}),
    },
  });

  throw new HttpsError(httpCodeFor(decision), decision.message);
}

/**
 * Adding a seat (invite, or any path that creates a user).
 *
 * Counted against EXISTING users including disabled ones — see `countCompanyUsers`
 * for why a suspended user still holds a seat.
 */
export async function assertCanAddUser(companyId: string, actorUid: string): Promise<void> {
  const [ent, users] = await Promise.all([resolveCompanyEntitlements(companyId), countCompanyUsers(companyId)]);
  await enforce(companyId, actorUid, 'user.create', checkCanAddUser(ent, users));
}

/**
 * Creating a proposal (new or duplicated).
 *
 * Drafts count. A draft is a live proposal that consumes the tenant's ability to
 * run a conversation, and excluding drafts would let a company create a thousand
 * of them against a five-proposal plan.
 */
export async function assertCanCreateProposal(companyId: string, actorUid: string): Promise<void> {
  const [ent, active] = await Promise.all([resolveCompanyEntitlements(companyId), countActiveProposals(companyId)]);
  await enforce(companyId, actorUid, 'proposal.create', checkCanCreateProposal(ent, active));
}

/**
 * Storing a new knowledge document of `addMb` megabytes.
 *
 * Provided now, wired when document upload lands: the allowance is part of the
 * plan definition, and leaving the check until the uploader exists would mean
 * shipping storage without its limit for however long that gap lasted.
 */
export async function assertCanStoreDocuments(
  companyId: string,
  actorUid: string,
  addMb: number,
): Promise<void> {
  const [ent, used] = await Promise.all([resolveCompanyEntitlements(companyId), totalDocumentMb(companyId)]);
  await enforce(companyId, actorUid, 'document.upload', checkCanStoreDocuments(ent, used, addMb));
}

/** A feature gate (advanced analytics, custom branding, document intelligence). */
export async function assertFeature(companyId: string, actorUid: string, feature: FeatureKey): Promise<void> {
  const ent = await resolveCompanyEntitlements(companyId);
  await enforce(companyId, actorUid, `feature.${feature}`, checkFeature(ent, feature));
}

/**
 * Resolve entitlements for a caller that needs the raw object (for display, or to
 * pass a resolved cap into a non-throwing check such as the AI budget).
 */
export async function entitlementsFor(companyId: string): Promise<ResolvedEntitlements> {
  return resolveCompanyEntitlements(companyId);
}
