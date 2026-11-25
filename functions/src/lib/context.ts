/**
 * Prospect request context resolution.
 *
 * This module is the tenant-isolation chokepoint for everything a prospect can
 * reach. Rules enforced here, in order:
 *
 *   1. The session signature must verify (no forged context).
 *   2. The access token record must exist, be unrevoked and unexpired — this is
 *      what makes revocation immediate (requirement 2).
 *   3. The proposal must exist and belong to the company named in the session.
 *      A mismatch is reported as "not found" so tenants cannot probe.
 *   4. The proposal must be published.
 *   5. The origin the session was minted for must still be the origin making the
 *      request, so a session cannot be replayed from a different site.
 *
 * Only after all five does it assemble the model context — and the internal
 * record's sensitive fields are reduced to policy scalars before that, so the
 * raw internal document never enters a prompt or a response.
 */
import { db, COLLECTIONS, FieldValue, Timestamp } from './firebase.js';
import { verifySession, SessionError, type SessionPayload } from './tokens.js';
import { AppError } from './errors.js';
import { normaliseOrigin, type RuntimeConfig } from './config.js';
import {
  AgentConfigInput,
  ProposalInternalInput,
  type AiReply,
} from './domain.js';
import type { PromptFacts } from './prompt.js';
// Re-exported so existing callers keep working, but the implementation lives in
// a dependency-free module shared with the seed script and staff functions.
import { canonicalProposalDocument, hashProposalDocument } from './document.js';

export { canonicalProposalDocument, hashProposalDocument };

export interface ProspectContext {
  session: SessionPayload;
  companyId: string;
  companyName: string;
  proposalId: string;
  proposal: ProposalRecord;
  agent: AgentConfigInput;
  internal: ProposalInternalInput;
  facts: PromptFacts;
  /** Which CTAs are actually enabled, resolved server-side. */
  ctas: Array<{ id: string; label: string; url: string }>;
  retentionDays: number;
}

export interface ProposalRecord {
  companyId: string;
  ownerUid: string;
  title: string;
  prospectName: string;
  prospectCompany: string;
  prospectEmail: string;
  summary: string;
  totalValueMinor: number;
  commencementMinor: number;
  currency: 'USD';
  hostedProposalUrl: string;
  termsNote: string;
  validUntil: string;
  status: 'draft' | 'published' | 'archived';
  documentVersion: number;
  documentHash: string;
}

function docToProposal(id: string, data: Record<string, unknown>): ProposalRecord {
  return {
    companyId: String(data.companyId ?? ''),
    ownerUid: String(data.ownerUid ?? ''),
    title: String(data.title ?? ''),
    prospectName: String(data.prospectName ?? ''),
    prospectCompany: String(data.prospectCompany ?? ''),
    prospectEmail: String(data.prospectEmail ?? ''),
    summary: String(data.summary ?? ''),
    totalValueMinor: Number(data.totalValueMinor ?? 0),
    commencementMinor: Number(data.commencementMinor ?? 0),
    currency: 'USD',
    hostedProposalUrl: String(data.hostedProposalUrl ?? ''),
    termsNote: String(data.termsNote ?? ''),
    validUntil: String(data.validUntil ?? ''),
    status: (data.status as ProposalRecord['status']) ?? 'draft',
    documentVersion: Number(data.documentVersion ?? 1),
    documentHash: String(data.documentHash ?? ''),
  };
}

/**
 * Resolve a prospect session into a fully validated context.
 * Throws AppError with a prospect-safe code on every failure path.
 */
export async function resolveProspectContext(
  sessionToken: unknown,
  requestOrigin: string | undefined,
  cfg: RuntimeConfig,
): Promise<ProspectContext> {
  let session: SessionPayload;
  try {
    session = verifySession(sessionToken, cfg.sessionSecret);
  } catch (err) {
    if (err instanceof SessionError && err.reason === 'expired') {
      throw new AppError(401, 'token_expired', 'Session expired');
    }
    throw new AppError(401, 'unauthorized', 'Invalid session');
  }

  // The session is bound to the origin it was minted for. A session lifted from
  // one embed site cannot be replayed from another.
  if (requestOrigin && normaliseOrigin(requestOrigin) !== normaliseOrigin(session.org)) {
    throw new AppError(403, 'forbidden', 'Session origin mismatch');
  }

  // ---- access token state (revocation is checked on every request) ----
  const tokenRef = db.collection(COLLECTIONS.accessTokens).doc(session.tid);
  const tokenSnap = await tokenRef.get();
  if (!tokenSnap.exists) throw new AppError(401, 'token_revoked', 'Token unknown');
  const token = tokenSnap.data() as {
    companyId?: string;
    proposalId?: string;
    revokedAt?: Timestamp | null;
    expiresAt?: Timestamp | null;
  };

  if (token.revokedAt) throw new AppError(401, 'token_revoked', 'Token revoked');
  if (token.expiresAt && token.expiresAt.toMillis() <= Date.now()) {
    throw new AppError(401, 'token_expired', 'Token expired');
  }
  // Token must match the session; prevents a session referencing a foreign token.
  if (token.companyId !== session.cid || token.proposalId !== session.pid) {
    throw new AppError(401, 'unauthorized', 'Token/session mismatch');
  }

  // ---- proposal ----
  const proposalSnap = await db.collection(COLLECTIONS.proposals).doc(session.pid).get();
  if (!proposalSnap.exists) throw new AppError(404, 'not_found', 'Proposal not found');
  const proposal = docToProposal(proposalSnap.id, proposalSnap.data() as Record<string, unknown>);

  // Tenant assertion: reported as not-found, not forbidden, to avoid probing.
  if (proposal.companyId !== session.cid) throw new AppError(404, 'not_found', 'Proposal not found');
  if (proposal.status !== 'published') throw new AppError(403, 'not_published', 'Not published');

  // ---- company ----
  const companySnap = await db.collection(COLLECTIONS.companies).doc(session.cid).get();
  if (!companySnap.exists) throw new AppError(404, 'not_found', 'Company not found');
  const companyData = companySnap.data() as Record<string, unknown>;
  const retentionDays = Number((companyData.settings as Record<string, unknown>)?.retentionDays ?? 365);

  // ---- agent config (prospect-visible knowledge) ----
  const agentSnap = await db.collection(COLLECTIONS.agentConfigs).doc(session.pid).get();
  const agentParsed = AgentConfigInput.safeParse(agentSnap.exists ? agentSnap.data() : {});
  const agent = agentParsed.success ? agentParsed.data : AgentConfigInput.parse({});

  // ---- internal record (never returned; reduced to policy scalars) ----
  const internalSnap = await db.collection(COLLECTIONS.proposalInternal).doc(session.pid).get();
  const internalParsed = ProposalInternalInput.safeParse(internalSnap.exists ? internalSnap.data() : {});
  const internal = internalParsed.success
    ? internalParsed.data
    : ProposalInternalInput.parse({ priceFloorMinor: 0, maxDiscountPercent: 0 });

  // Tenant assertion on the internal record too.
  if (internalSnap.exists) {
    const internalCompany = (internalSnap.data() as { companyId?: string }).companyId;
    if (internalCompany !== session.cid) throw new AppError(404, 'not_found', 'Proposal not found');
  }

  const ctas = agent.ctaLinks.filter((c) => c.enabled).map((c) => ({ id: c.id, label: c.label, url: c.url }));

  const facts: PromptFacts = {
    companyName: String(companyData.name ?? 'the seller'),
    proposalTitle: proposal.title,
    prospectName: proposal.prospectName,
    prospectCompany: proposal.prospectCompany,
    summary: proposal.summary,
    totalValueMinor: proposal.totalValueMinor,
    commencementMinor: proposal.commencementMinor,
    termsNote: proposal.termsNote,
    validUntil: proposal.validUntil,
    enabledCtas: ctas,
  };

  // Best-effort usage stamp; failure must not block the conversation.
  void tokenRef
    .update({ lastUsedAt: FieldValue.serverTimestamp(), useCount: FieldValue.increment(1) })
    .catch(() => undefined);

  return {
    session,
    companyId: session.cid,
    companyName: facts.companyName,
    proposalId: session.pid,
    proposal,
    agent,
    internal,
    facts,
    ctas,
    retentionDays,
  };
}

/**
 * Resolve a CTA id to an approved URL. The model selects an id; it never emits a
 * URL. If the id is unknown or disabled, no link is returned at all.
 */
export function resolveCta(ctx: ProspectContext, ctaId: AiReply['cta_id']): { id: string; label: string; url: string } | null {
  if (!ctaId) return null;
  return ctx.ctas.find((c) => c.id === ctaId) ?? null;
}
