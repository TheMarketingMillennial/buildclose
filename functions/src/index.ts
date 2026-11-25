/**
 * BuildClose Cloud Functions entry point.
 *
 * Structure:
 *   - `api`       — Express app for public prospect endpoints (bootstrap, chat,
 *                   event, accept, decline). Origin-locked, rate limited.
 *   - staff       — callable functions requiring Firebase Auth + custom claims.
 *   - webhooks    — Stripe, mounted with a raw body parser.
 *
 * Why one Express app rather than one function per route: the prospect API needs
 * shared middleware (CORS, security headers, error mapping) and a single cold
 * start serves the whole conversation. Staff operations stay as individual
 * callables so each gets its own auth check and its own IAM surface.
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';

import { AppError, prospectMessage } from './lib/errors.js';
import { corsMiddleware, securityHeaders } from './http/helpers.js';
import { bootstrapHandler } from './http/bootstrap.js';
import { chatHandler } from './http/chat.js';
import { eventHandler } from './http/events.js';
import { termsHandler } from './http/terms.js';
import { acceptHandler, declineHandler } from './http/acceptance.js';

// Conservative defaults: cap instances so a traffic spike cannot run up cost,
// and keep each instance small (the workload is IO-bound on the model call).
setGlobalOptions({
  region: 'us-central1',
  maxInstances: 20,
  memory: '512MiB',
  timeoutSeconds: 60,
});

const app = express();

// Security headers on every response, including errors.
app.use(securityHeaders);
app.use(corsMiddleware);

// Body limit guards against absurd payloads; a chat message is capped at 2 000
// characters by the handler, so 64 kb is generous but bounded.
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'buildclose', ts: Date.now() });
});

app.post('/api/bootstrap', (req, res, next) => {
  Promise.resolve(bootstrapHandler(req, res)).catch(next);
});
app.post('/api/chat', (req, res, next) => {
  Promise.resolve(chatHandler(req, res)).catch(next);
});
app.post('/api/event', (req, res, next) => {
  Promise.resolve(eventHandler(req, res)).catch(next);
});
app.post('/api/terms', (req, res, next) => {
  Promise.resolve(termsHandler(req, res)).catch(next);
});
app.post('/api/accept', (req, res, next) => {
  Promise.resolve(acceptHandler(req, res)).catch(next);
});
app.post('/api/decline', (req, res, next) => {
  Promise.resolve(declineHandler(req, res)).catch(next);
});

/**
 * Fallback error handler: never leak a stack trace to a prospect.
 *
 * This MUST map AppError to its real status. Collapsing every failure to 500 was
 * a live defect: a revoked token, an unpublished proposal and a rate-limited
 * caller all reached the client as `internal_error`, so the widget could not tell
 * a retryable throttle from a dead link, and `Retry-After` never reached the
 * browser. Unknown errors still degrade to a generic 500.
 */
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;

  const safe = prospectMessage(err);
  if (safe.retryAfter !== undefined) res.setHeader('Retry-After', String(safe.retryAfter));

  if (!(err instanceof AppError)) {
    // Body-parser failures are client faults and carry a useful status; only
    // genuinely unexpected errors are worth logging and masking as 500.
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_request', message: 'That request could not be processed.' } });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'bad_request', message: 'That request could not be processed.' } });
      return;
    }
    console.error('[api] unhandled', (err as Error)?.message);
  }

  res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
});

export const api = onRequest(
  {
    region: 'us-central1',
    // Trimmed instance count for the public surface; this is the DoS-exposed part.
    maxInstances: 10,
    secrets: ['OPENAI_API_KEY', 'SESSION_SECRET'],
  },
  app,
);

// ---------------------------------------------------------------- staff API
export {
  createProposal,
  getProposal,
  listProposals,
  updateProposal,
  publishProposal,
  unpublishProposal,
  archiveProposal,
  duplicateProposal,
  mintAccessToken,
  revokeAccessToken,
  listAccessTokens,
} from './staff/proposals.js';

export {
  getCompanyDashboard,
  getProposalAnalytics,
  getConversation,
  getAuditLog,
} from './staff/intelligence.js';

export { inviteStaff, setStaffRole, listStaff, bootstrapCompany } from './staff/team.js';

export { createCheckoutSession, stripeWebhook } from './staff/stripe.js';
