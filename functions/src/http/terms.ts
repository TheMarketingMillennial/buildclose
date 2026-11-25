/**
 * POST /api/terms — the approved commercial DTO for a prospect session.
 *
 * This is the only place commercial terms reach the browser, and it is an
 * explicit allowlist rather than a filtered document. Anything not named here
 * cannot leak: there is no field to forget to strip.
 *
 * It also returns `documentHash` and `documentVersion` so the acceptance form can
 * echo exactly what the prospect was shown. The hash is computed server-side from
 * the same canonical projection used at acceptance, so a client cannot fabricate
 * agreement to terms it never displayed.
 *
 * Note what is absent by design: price floor, discount authority, negotiation
 * boundaries, competitor posture, internal notes, and any other tenant's data.
 */
import type { Request, Response } from 'express';
import { getConfig } from '../lib/config.js';
import { AppError } from '../lib/errors.js';
import { consume } from '../lib/ratelimit.js';
import { hashIp } from '../lib/tokens.js';
import { resolveProspectContext } from '../lib/context.js';
import { hashProposalDocument } from '../lib/document.js';
import { bearerToken, clientIp } from './helpers.js';

export async function termsHandler(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  const ipHash = hashIp(clientIp(req), cfg.ipSalt);
  const sessionToken = bearerToken(req);

  const limit = await consume([{ key: `terms:ip:${ipHash}`, limit: 60, windowSec: 60 }]);
  if (!limit.allowed) throw new AppError(429, 'rate_limited', 'Too many requests', limit.retryAfter);

  const ctx = await resolveProspectContext(sessionToken, req.headers.origin as string | undefined, cfg);

  res.status(200).json({
    proposal: {
      title: ctx.proposal.title,
      prospectName: ctx.proposal.prospectName,
      prospectCompany: ctx.proposal.prospectCompany,
      summary: ctx.proposal.summary,
      totalValueMinor: ctx.proposal.totalValueMinor,
      commencementMinor: ctx.proposal.commencementMinor,
      currency: ctx.proposal.currency,
      termsNote: ctx.proposal.termsNote,
      validUntil: ctx.proposal.validUntil,
      hostedProposalUrl: ctx.proposal.hostedProposalUrl,
    },
    // Evidence binding for acceptance.
    documentVersion: ctx.proposal.documentVersion,
    documentHash: hashProposalDocument(ctx.proposal),
    acceptanceStatus: (ctx.proposal as unknown as { acceptanceStatus?: string }).acceptanceStatus ?? 'none',
    // Approved calls to action, resolved server-side.
    ctas: ctx.ctas,
    // Disclosure surface: the UI must show these.
    disclosure: {
      conversationLogged: true,
      retentionDays: ctx.retentionDays,
      assistantIsAI: true,
    },
  });
}
