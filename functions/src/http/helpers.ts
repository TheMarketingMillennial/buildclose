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
import { AppError, prospectMessage } from '../lib/errors.js';
import { allowedCorsOrigin, getConfig } from '../lib/config.js';

/** Origins permitted to call the prospect API: the chat app, plus dev hosts. */
export function permittedApiOrigins(): string[] {
  const cfg = getConfig();
  const base = [cfg.chatOrigin, cfg.embedOrigin];
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

/** Wrap an async handler so rejections become prospect-safe JSON errors. */
export function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      const safe = prospectMessage(err);
      if (safe.retryAfter !== undefined) res.setHeader('Retry-After', String(safe.retryAfter));
      if (!(err instanceof AppError)) {
        console.error('[http] unhandled error', (err as Error)?.message);
      }
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  };
}

/** Best-effort client IP; Cloud Functions sets x-forwarded-for. */
export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
  return req.ip ?? 'unknown';
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}
