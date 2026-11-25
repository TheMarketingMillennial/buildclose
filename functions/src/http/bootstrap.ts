/**
 * POST /api/bootstrap
 *
 * Exchanges a prospect's access token for a short-lived session.
 *
 * This is the only endpoint that accepts a raw proposal token, and it does not
 * accept it more than necessary: the token is hashed and looked up, never stored
 * in plaintext, and the session it returns is bound to this proposal, this
 * company and the calling origin.
 *
 * Public embed keys and domain allowlisting are NOT the authorisation mechanism
 * (requirement 2). The token record is. Embed origin is recorded and, when a
 * token is restricted to specific domains, enforced additively.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db, COLLECTIONS, FieldValue, Timestamp } from '../lib/firebase.js';
import { looksLikeProposalToken, hashToken, createSession } from '../lib/tokens.js';
import { getConfig } from '../lib/config.js';
import { AppError, badRequest } from '../lib/errors.js';
import { consume } from '../lib/ratelimit.js';
import { hashIp } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';
import { clientIp, permittedApiOrigins } from './helpers.js';

const SESSION_TTL_SECONDS = 60 * 60; // 1 hour — long enough for a real conversation

const Body = z.object({
  token: z.string().min(10).max(200),
  /** Origin of the page hosting the widget, reported by the widget. Client-asserted. */
  embedOrigin: z.string().max(300).optional(),
});

export async function bootstrapHandler(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw badRequest('Invalid request body');

  const { token, embedOrigin } = parsed.data;

  // Shape check before hashing so malformed input cannot become a DB probe.
  if (!looksLikeProposalToken(token)) throw new AppError(401, 'unauthorized', 'Invalid token');

  // Throttle token exchanges per IP: this endpoint is the only brute-forceable
  // surface, and a 256-bit token makes guessing infeasible but not free.
  const ip = clientIp(req);
  const limit = await consume([
    { key: `bootstrap:ip:${hashIp(ip, cfg.ipSalt)}`, limit: 30, windowSec: 60 },
  ]);
  if (!limit.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many attempts', limit.retryAfter);
  }

  const tokenHash = hashToken(token);
  const tokenRef = db.collection(COLLECTIONS.accessTokens).doc(tokenHash);
  const snap = await tokenRef.get();
  if (!snap.exists) throw new AppError(401, 'unauthorized', 'Invalid token');

  const record = snap.data() as {
    companyId?: string;
    proposalId?: string;
    revokedAt?: Timestamp | null;
    expiresAt?: Timestamp | null;
    allowedOrigins?: string[];
    label?: string;
  };

  if (record.revokedAt) throw new AppError(401, 'token_revoked', 'Token revoked');
  if (record.expiresAt && record.expiresAt.toMillis() <= Date.now()) {
    throw new AppError(401, 'token_expired', 'Token expired');
  }
  if (!record.companyId || !record.proposalId) throw new AppError(401, 'unauthorized', 'Invalid token');

  // Additive defence: if the token is pinned to specific hosting domains, honour
  // that. Absent pinning, the token alone authorises — which is what makes the
  // embed code reusable on any site the sender chooses.
  if (Array.isArray(record.allowedOrigins) && record.allowedOrigins.length > 0) {
    const origin = (embedOrigin ?? '').trim().toLowerCase().replace(/\/+$/, '');
    const permitted = record.allowedOrigins.map((o) => o.trim().toLowerCase().replace(/\/+$/, ''));
    if (!origin || !permitted.includes(origin)) {
      throw new AppError(403, 'origin_not_allowed', 'Origin not permitted for this token');
    }
  }

  // The caller itself must be a permitted API origin (the chat app, not the
  // customer's page). This stops a third-party page from calling bootstrap directly.
  const caller = (req.headers.origin as string | undefined)?.trim().toLowerCase().replace(/\/+$/, '');
  const permittedCallers = permittedApiOrigins().map((o) => o.trim().toLowerCase().replace(/\/+$/, ''));
  if (caller && !permittedCallers.includes(caller)) {
    throw new AppError(403, 'origin_not_allowed', 'Caller origin not permitted');
  }

  // Proposal must exist, belong to the token's company, and be published.
  const proposalSnap = await db.collection(COLLECTIONS.proposals).doc(record.proposalId).get();
  if (!proposalSnap.exists) throw new AppError(404, 'not_found', 'Proposal not found');
  const proposal = proposalSnap.data() as { companyId?: string; status?: string; title?: string; prospectName?: string };
  if (proposal.companyId !== record.companyId) throw new AppError(404, 'not_found', 'Proposal not found');
  if (proposal.status !== 'published') throw new AppError(403, 'not_published', 'Not published');

  // The session is bound to the origin that will actually CALL the API — that is
  // the chat app, since the widget never calls the API directly. This is distinct
  // from `embedOrigin` (the customer's proposal page), which is used only for the
  // per-token allowlist check and for audit. Conflating the two would bind every
  // session to the customer's page origin and reject the chat app's own requests.
  const callerOrigin = (req.headers.origin as string | undefined)?.trim().replace(/\/+$/, '');
  const sessionOrigin = callerOrigin || cfg.chatOrigin;

  const { token: sessionToken, payload } = createSession(
    {
      cid: record.companyId,
      pid: record.proposalId,
      tid: tokenHash,
      org: sessionOrigin,
    },
    cfg.sessionSecret,
    SESSION_TTL_SECONDS,
  );

  await tokenRef.update({ lastExchangedAt: FieldValue.serverTimestamp() }).catch(() => undefined);

  await audit({
    companyId: record.companyId,
    action: 'session.minted',
    actorType: 'prospect',
    proposalId: record.proposalId,
    ipHash: hashIp(ip, cfg.ipSalt),
    detail: { tokenLabel: record.label ?? null, embedOrigin: sessionOrigin },
  });

  // Deliberately minimal payload: enough to render the shell, nothing about the
  // commercial terms. Those arrive through the chat endpoint's approved DTO.
  res.status(200).json({
    session: sessionToken,
    expiresAt: payload.exp * 1000,
    proposal: {
      title: String(proposal.title ?? 'Proposal'),
      prospectName: String(proposal.prospectName ?? ''),
    },
  });
}
