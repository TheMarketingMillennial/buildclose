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

import { createApp } from './app.js';

// Conservative defaults: cap instances so a traffic spike cannot run up cost,
// and keep each instance small (the workload is IO-bound on the model call).
setGlobalOptions({
  region: 'us-central1',
  maxInstances: 20,
  memory: '512MiB',
  timeoutSeconds: 60,
});

// The Express app lives in app.ts so tests can mount the exact same middleware
// chain without going through the emulator (which injects its own permissive CORS
// layer and would mask real behaviour). One app instance per cold start.
const app = createApp();

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
