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
import {
  reserveSeat,
  reserveProposalSlot as reserveProposalSlotTxn,
  releaseProposalSlot,
  releaseSeatOnRemoval,
} from './usage.js';

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
 * CONCURRENCY: the decision and the increment happen in ONE transaction against a
 * counter document. A count-then-write check is racy — five parallel invites on a
 * one-seat plan each read "0 seats" and all succeed. See lib/usage.ts for why a
 * counter document, and not a re-counting transaction, is what actually serialises
 * competitors.
 *
 * Returns a settlement handle. The caller MUST release it if the invite then
 * fails, or the slot leaks. `reserveSeat` is deliberately not named `assert...`
 * because it mutates state and therefore carries an obligation.
 */
export async function reserveUserSeat(
  companyId: string,
  actorUid: string,
): Promise<{ release: () => Promise<void> }> {
  const [ent, liveUsers] = await Promise.all([
    resolveCompanyEntitlements(companyId),
    countCompanyUsers(companyId),
  ]);

  // Cheap pre-check first, so the common refusal does not open a transaction.
  const pre = checkCanAddUser(ent, liveUsers);
  if (!pre.allowed) await enforce(companyId, actorUid, 'user.create', pre);

  const { outcome, reservation } = await reserveSeat(companyId, ent.limits.maxUsers, liveUsers);
  if (!outcome.allowed) {
    // The authoritative check lost the race: report it with the live count.
    await enforce(companyId, actorUid, 'user.create', {
      allowed: false,
      code: 'plan_limit_reached',
      message: `Your plan includes ${ent.limits.maxUsers} user${ent.limits.maxUsers === 1 ? '' : 's'}. Upgrade to add more.`,
      limit: ent.limits.maxUsers,
      use: outcome.used - 1,
    });
  }

  return { release: reservation.release };
}

/**
 * Creating a proposal (new or duplicated).
 *
 * Same transactional reservation as seats. Drafts count: a draft is a live
 * proposal that consumes the tenant's ability to run a conversation, and excluding
 * drafts would let a company create a thousand against a five-proposal plan.
 *
 * The caller must `release()` if the creation itself fails after this point.
 */
export async function reserveProposalSlot(
  companyId: string,
  actorUid: string,
): Promise<{ release: () => Promise<void> }> {
  const [ent, liveActive] = await Promise.all([
    resolveCompanyEntitlements(companyId),
    countActiveProposals(companyId),
  ]);

  const pre = checkCanCreateProposal(ent, liveActive);
  if (!pre.allowed) await enforce(companyId, actorUid, 'proposal.create', pre);

  const { outcome, reservation } = await reserveProposalSlotTxn(
    companyId,
    ent.limits.maxActiveProposals,
    liveActive,
  );
  if (!outcome.allowed) {
    await enforce(companyId, actorUid, 'proposal.create', {
      allowed: false,
      code: 'plan_limit_reached',
      message: `Your plan includes ${ent.limits.maxActiveProposals} active proposal${ent.limits.maxActiveProposals === 1 ? '' : 's'}. Archive or upgrade to create more.`,
      limit: ent.limits.maxActiveProposals,
      use: outcome.used - 1,
    });
  }

  return { release: reservation.release };
}

/** Free a proposal slot when one is archived (archived work holds no slot). */
export async function releaseProposalSlotFor(companyId: string): Promise<void> {
  await releaseProposalSlot(companyId);
}

/** Free a seat when a member is removed. Not yet used; exposed for symmetry. */
export async function releaseUserSeatFor(companyId: string): Promise<void> {
  await releaseSeatOnRemoval(companyId);
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
