/**
 * The public prospect API as a plain Express app.
 *
 * Extracted from index.ts so the middleware chain can be mounted in a test
 * process with no Firebase emulator in the path. That matters: the emulator wraps
 * every function in its own permissive CORS layer, so integration tests that assert
 * CORS behaviour through port 5001 are measuring the emulator, not BuildClose.
 * See tests/middleware.test.mjs.
 */
import express from 'express';
import type { Express } from 'express';

import { AppError, prospectMessage } from './lib/errors.js';
import { corsMiddleware, securityHeaders } from './http/helpers.js';
import { bootstrapHandler } from './http/bootstrap.js';
import { chatHandler } from './http/chat.js';
import { eventHandler } from './http/events.js';
import { termsHandler } from './http/terms.js';
import { acceptHandler, declineHandler } from './http/acceptance.js';

/** Wrap an async handler so a rejection reaches the error middleware. */
const route =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

export function createApp(): Express {
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

  app.post('/api/bootstrap', route(bootstrapHandler));
  app.post('/api/chat', route(chatHandler));
  app.post('/api/event', route(eventHandler));
  app.post('/api/terms', route(termsHandler));
  app.post('/api/accept', route(acceptHandler));
  app.post('/api/decline', route(declineHandler));

  /**
   * Fallback error handler: never leak a stack trace to a prospect.
   *
   * This MUST map AppError to its real status. Collapsing every failure to 500 was
   * a live defect: a revoked token, an unpublished proposal and a rate-limited
   * caller all reached the client as `internal_error`, so the widget could not tell
   * a retryable throttle from a dead link, and `Retry-After` never reached the
   * browser. Unknown errors still degrade to a generic 500.
   */
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;

      const safe = prospectMessage(err);
      if (safe.retryAfter !== undefined) res.setHeader('Retry-After', String(safe.retryAfter));

      if (!(err instanceof AppError)) {
        // Body-parser failures are client faults and carry a usable status; only
        // genuinely unexpected errors are worth logging and masking as 500.
        const type = (err as { type?: string } | null)?.type;
        if (type === 'entity.parse.failed') {
          res
            .status(400)
            .json({ error: { code: 'bad_request', message: 'That request could not be processed.' } });
          return;
        }
        if (type === 'entity.too.large') {
          res
            .status(413)
            .json({ error: { code: 'bad_request', message: 'That request could not be processed.' } });
          return;
        }
        console.error('[api] unhandled', (err as Error)?.message);
      }

      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    },
  );

  return app;
}
