/**
 * Shared HTTP plumbing for the public prospect endpoints.
 *
 * CORS posture: the only legitimate caller of these endpoints is the chat app
 * running on CHAT_ORIGIN. The embeddable widget never calls the API directly —
 * it postMessages into the chat iframe — so there is exactly one allowed origin
 * per environment plus localhost during development. The matched origin is
 * echoed back rather than '*', because these responses vary by caller and must
 * never be cacheable across origins.
 */
import type { Request, Response, NextFunction } from 'express';
import { allowedCorsOrigin, getConfig } from '../lib/config.js';

/**
 * Origins permitted to call the prospect API.
 *
 * Only the chat app qualifies. The embeddable widget never calls the API — it
 * posts a message into the chat iframe — and the dashboard talks to the staff
 * callables, not here. Keeping this list to the single chat origin is what makes
 * the CORS check meaningful: a customer page holding a valid token still cannot
 * call the API directly, because its origin is not on this list.
 */
export function permittedApiOrigins(): string[] {
  const cfg = getConfig();
  const base = [cfg.chatOrigin];
  if (process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV !== 'production') {
    base.push('http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4321', 'http://127.0.0.1:4321');
  }
  return base;
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const match = allowedCorsOrigin(typeof origin === 'string' ? origin : undefined, permittedApiOrigins());

  if (match) {
    res.setHeader('Access-Control-Allow-Origin', match);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    // Preflight for a disallowed origin gets no allow headers and stops here.
    res.status(match ? 204 : 403).end();
    return;
  }
  next();
}

/** Attach security headers appropriate for a JSON API (never framed, never sniffed). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Client IP used for rate limiting.
 *
 * Takes the RIGHTMOST X-Forwarded-For entry, not the leftmost.
 *
 * This is a security fix, not a style choice. Cloud Run puts the calling IP at the
 * end of the chain, and anything to its left was supplied by the caller. Reading
 * the leftmost value let a client send a fresh `X-Forwarded-For` on every request,
 * land in a new rate-limit bucket each time, and bypass the limiter entirely —
 * which defeated the bootstrap brute-force guard and the per-IP chat throttle.
 *
 * Assumption: exactly one trusted proxy hop (the platform front end). If a CDN is
 * ever placed in front, this must be revised to strip a known number of hops.
 */
export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const parts = xff
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return req.ip ?? 'unknown';
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}
