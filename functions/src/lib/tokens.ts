/**
 * Proposal access tokens and prospect sessions.
 *
 * Requirement 2: prospect access must be per-prospect, secure and revocable.
 * Public embed keys and domain allowlisting are *not* sufficient on their own,
 * so they are only ever used to reach the chat shell — never to authorise a
 * read of proposal data.
 *
 * Model:
 *   1. A 256-bit random proposal token is generated server-side and shown once
 *      to the sender as part of the proposal link. Only its SHA-256 hash is
 *      stored, so a database read cannot reconstruct a working link.
 *   2. The token is exchanged (POST /api/bootstrap) for a short-lived session
 *      bound to { companyId, proposalId, tokenId, origin }. The session is an
 *      HMAC-signed blob, so it needs no server-side lookup to verify integrity,
 *      but revocation is still enforced by checking the token record.
 *   3. Revoking the token record kills every session derived from it, because
 *      each request re-checks the token's state.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'bc_pk_';
const SESSION_VERSION = 1;

export interface SessionPayload {
  v: number;
  sid: string; // session id (for logging / rate limiting)
  cid: string; // companyId
  pid: string; // proposalId
  tid: string; // access-token document id (hash) — enables revocation checks
  org: string; // origin the session was minted for
  iat: number;
  exp: number;
}

export interface MintedToken {
  /** Shown to the sender once. Never persisted. */
  plaintext: string;
  /** Primary key in `accessTokens`. */
  hash: string;
}

/** Generate a new proposal access token. */
export function mintProposalToken(): MintedToken {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  return { plaintext, hash: hashToken(plaintext) };
}

/** SHA-256 of the full token. Used as the Firestore document id. */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Reject anything that is not shaped like a BuildClose token before hashing. */
export function looksLikeProposalToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= 40 && value.length <= 64;
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data, 'utf8').digest());
}

/** Constant-time string comparison that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createSession(
  input: Omit<SessionPayload, 'v' | 'iat' | 'exp' | 'sid'>,
  secret: string,
  ttlSeconds: number,
): { token: string; payload: SessionPayload } {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    sid: randomBytes(16).toString('base64url'),
    ...input,
    iat: now,
    exp: now + ttlSeconds,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { token: `${body}.${sign(body, secret)}`, payload };
}

export class SessionError extends Error {
  constructor(public readonly reason: 'malformed' | 'bad_signature' | 'expired') {
    super(`Session ${reason}`);
    this.name = 'SessionError';
  }
}

/** Verify signature and expiry. Does NOT check revocation — callers must do that. */
export function verifySession(token: unknown, secret: string): SessionPayload {
  if (typeof token !== 'string' || token.length > 4096) throw new SessionError('malformed');
  const parts = token.split('.');
  if (parts.length !== 2) throw new SessionError('malformed');
  const [body, sig] = parts as [string, string];
  if (!safeEqual(sig, sign(body, secret))) throw new SessionError('bad_signature');

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    throw new SessionError('malformed');
  }
  if (
    payload?.v !== SESSION_VERSION ||
    typeof payload.cid !== 'string' ||
    typeof payload.pid !== 'string' ||
    typeof payload.tid !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    throw new SessionError('malformed');
  }
  if (payload.exp * 1000 <= Date.now()) throw new SessionError('expired');
  return payload;
}

/**
 * Salted IP hash for rate limiting. We never store raw IPs in analytics, only
 * inside audit records where an explicit legal basis exists.
 */
export function hashIp(ip: string | undefined, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip ?? 'unknown'}`, 'utf8').digest('hex').slice(0, 32);
}
