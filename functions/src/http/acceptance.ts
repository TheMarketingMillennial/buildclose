/**
 * POST /api/accept  — native proposal acceptance.
 *
 * Requirement 6: native acceptance with document versioning, explicit consent,
 * timestamps and an audit trail, while preserving a path to real e-signature.
 *
 * The integrity property that matters: the prospect must accept the *exact*
 * terms they were reading. We achieve that by hashing a canonical projection of
 * the commercial terms (not the rendered HTML, which changes with styling) and
 * requiring the client to echo the hash it displayed. A mismatch means the
 * proposal was republished mid-session — the acceptance is refused rather than
 * recorded against terms the prospect never saw.
 *
 * `signature` is stored behind an abstraction with `provider: 'native-typed'`.
 * Swapping in Dropbox Sign later means writing a new value there plus a webhook;
 * the acceptance record shape does not change.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getConfig } from '../lib/config.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { consume } from '../lib/ratelimit.js';
import { hashIp } from '../lib/tokens.js';
import { db, COLLECTIONS, FieldValue, Timestamp } from '../lib/firebase.js';
import { audit } from '../lib/audit.js';
import { resolveProspectContext, canonicalProposalDocument, hashProposalDocument } from '../lib/context.js';
import { ensureConversation, recordEvent } from '../lib/store.js';
import { AcceptanceInput } from '../lib/domain.js';
import { bearerToken, clientIp } from './helpers.js';

const Body = AcceptanceInput.extend({
  accept: z.literal(true, { errorMap: () => ({ message: 'Explicit acceptance is required' }) }),
});

export async function acceptHandler(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  const ip = clientIp(req);
  const ipHash = hashIp(ip, cfg.ipSalt);
  const sessionToken = bearerToken(req);

  const limit = await consume([{ key: `accept:ip:${ipHash}`, limit: 10, windowSec: 300 }]);
  if (!limit.allowed) throw new AppError(429, 'rate_limited', 'Too many attempts', limit.retryAfter);

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid acceptance payload');
  }
  const input = parsed.data;

  const ctx = await resolveProspectContext(sessionToken, req.headers.origin as string | undefined, cfg);

  // --- integrity: the client must have displayed the current terms ---
  const currentHash = hashProposalDocument(ctx.proposal);
  if (input.documentHash !== currentHash || input.documentVersion !== ctx.proposal.documentVersion) {
    throw conflict('The proposal has changed since it was opened. Please reload and review the current terms.');
  }

  const acceptanceId = `${ctx.proposalId}_${ctx.session.tid}`;

  // --- idempotency: one acceptance per prospect token ---
  const existing = await db.collection(COLLECTIONS.acceptances).doc(acceptanceId).get();
  if (existing.exists) {
    const prior = existing.data() as { acceptedAt?: Timestamp };
    res.status(200).json({
      ok: true,
      alreadyAccepted: true,
      acceptedAt: prior.acceptedAt?.toMillis() ?? null,
    });
    return;
  }

  const now = Date.now();
  const conversationId = await ensureConversation({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    tokenId: ctx.session.tid,
  });

  // Snapshot the exact canonical document so the record is self-verifying even
  // if the proposal is later edited or archived.
  const canonicalDocument = canonicalProposalDocument(ctx.proposal);

  const record = {
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    conversationId,
    acceptedAt: FieldValue.serverTimestamp(),
    acceptedAtMs: now,
    // --- who accepted ---
    fullName: input.fullName,
    email: input.email,
    title: input.title || null,
    // --- what they agreed to ---
    documentVersion: ctx.proposal.documentVersion,
    documentHash: currentHash,
    documentSnapshot: canonicalDocument,
    commercialTerms: {
      totalValueMinor: ctx.proposal.totalValueMinor,
      commencementMinor: ctx.proposal.commencementMinor,
      currency: ctx.proposal.currency,
      validUntil: ctx.proposal.validUntil,
    },
    // --- explicit consent ---
    consent: {
      given: true,
      statement:
        'I have read and agree to the proposal terms above, and I accept this proposal on behalf of my organisation.',
      givenAtMs: now,
    },
    // --- signature (provider-abstracted for future e-sign) ---
    signature: {
      provider: 'native-typed' as const,
      typedName: input.typedSignature,
      /** Reserved for a future provider: envelope id, certificate url, etc. */
      providerEnvelopeId: null as string | null,
      providerCertificateUrl: null as string | null,
    },
    // --- evidence ---
    evidence: {
      ipHash,
      userAgentHash: hashIp(String(req.headers['user-agent'] ?? ''), cfg.ipSalt),
      sessionId: ctx.session.sid,
      origin: ctx.session.org,
    },
    status: 'accepted' as const,
  };

  await db.collection(COLLECTIONS.acceptances).doc(acceptanceId).create(record);

  // Reflect acceptance state on the proposal for pipeline reporting.
  await db.collection(COLLECTIONS.proposals).doc(ctx.proposalId).update({
    acceptanceStatus: 'accepted',
    acceptedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await recordEvent({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    conversationId,
    type: 'proposal_accepted',
    meta: { documentVersion: ctx.proposal.documentVersion },
  });

  await audit({
    companyId: ctx.companyId,
    action: 'prospect.accepted',
    actorType: 'prospect',
    proposalId: ctx.proposalId,
    detail: {
      acceptanceId,
      documentVersion: ctx.proposal.documentVersion,
      documentHash: currentHash,
      signatureProvider: 'native-typed',
    },
    ipHash,
  });

  res.status(201).json({
    ok: true,
    acceptedAt: now,
    acceptanceId,
    documentVersion: ctx.proposal.documentVersion,
    documentHash: currentHash,
  });
}

/**
 * POST /api/decline — records a decline without closing the conversation.
 * Kept separate so "not now" is never conflated with "no".
 */
export async function declineHandler(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  const ipHash = hashIp(clientIp(req), cfg.ipSalt);
  const sessionToken = bearerToken(req);

  const limit = await consume([{ key: `decline:ip:${ipHash}`, limit: 10, windowSec: 300 }]);
  if (!limit.allowed) throw new AppError(429, 'rate_limited', 'Too many attempts', limit.retryAfter);

  const parsed = z.object({ reason: z.string().max(500).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest('Invalid request');

  const ctx = await resolveProspectContext(sessionToken, req.headers.origin as string | undefined, cfg);
  const conversationId = await ensureConversation({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    tokenId: ctx.session.tid,
  });

  await db.collection(COLLECTIONS.proposals).doc(ctx.proposalId).update({
    acceptanceStatus: 'declined',
    updatedAt: FieldValue.serverTimestamp(),
  });

  await recordEvent({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    conversationId,
    type: 'proposal_declined',
    meta: parsed.data.reason ? { reason: parsed.data.reason } : {},
  });

  await audit({
    companyId: ctx.companyId,
    action: 'prospect.declined',
    actorType: 'prospect',
    proposalId: ctx.proposalId,
    ipHash,
  });

  res.status(200).json({ ok: true });
}
