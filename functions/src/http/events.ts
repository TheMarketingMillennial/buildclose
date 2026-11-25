/**
 * POST /api/event — engagement tracking from the chat shell.
 *
 * Only a small, fixed set of client-observable events is accepted. Anything that
 * implies a commercial outcome (acceptance, payment) is written by the server
 * from the endpoint that actually performs the action, never reported by the
 * browser, so analytics cannot be inflated by a modified client.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getConfig } from '../lib/config.js';
import { AppError, badRequest } from '../lib/errors.js';
import { consume } from '../lib/ratelimit.js';
import { hashIp } from '../lib/tokens.js';
import { resolveProspectContext } from '../lib/context.js';
import { recordEvent, type EventType } from '../lib/store.js';
import { bearerToken, clientIp } from './helpers.js';

/** Events a browser is trusted to assert. Note what is absent. */
const CLIENT_EVENTS = ['proposal_view', 'unique_visit', 'chat_opened', 'cta_clicked', 'acceptance_started'] as const;

const Body = z.object({
  type: z.enum(CLIENT_EVENTS),
  ctaId: z.string().max(60).optional(),
  meta: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
});

export async function eventHandler(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  const ipHash = hashIp(clientIp(req), cfg.ipSalt);
  const sessionToken = bearerToken(req);

  const limit = await consume([{ key: `event:ip:${ipHash}`, limit: 120, windowSec: 60 }]);
  if (!limit.allowed) throw new AppError(429, 'rate_limited', 'Too many events', limit.retryAfter);

  // Authenticate BEFORE validating the body. Two reasons: an unauthenticated
  // caller should receive 401 rather than a hint about the expected schema, and
  // the endpoint's contract is "requires a session" — a malformed body from a
  // session-less caller is still an auth failure, not a client-input failure.
  const ctx = await resolveProspectContext(sessionToken, req.headers.origin as string | undefined, cfg);

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw badRequest('Invalid event');

  // A cta_clicked event can only reference a CTA that exists and is enabled.
  if (parsed.data.type === 'cta_clicked' && parsed.data.ctaId) {
    if (!ctx.ctas.some((c) => c.id === parsed.data.ctaId)) {
      throw badRequest('Unknown call to action');
    }
  }

  await recordEvent({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    type: parsed.data.type as EventType,
    meta: { ...(parsed.data.meta ?? {}), ...(parsed.data.ctaId ? { ctaId: parsed.data.ctaId } : {}) },
  });

  res.status(202).json({ ok: true });
}
