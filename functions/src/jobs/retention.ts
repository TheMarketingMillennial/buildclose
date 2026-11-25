/**
 * Retention purge entry points.
 *
 * Two surfaces, deliberately:
 *
 *   retentionPurge  — scheduled. This is what honours the retention disclosure the
 *                     prospect was shown. Runs daily and sweeps every company.
 *   runRetentionPurge — staff callable, admin-only. Exists for two honest reasons:
 *                     an operator needs to purge a single company on request
 *                     (a data-deletion request cannot wait for tonight's cron),
 *                     and the emulator cannot invoke a Cloud Scheduler job, so
 *                     this is also how the behaviour is tested end to end.
 *
 * The callable is admin-gated rather than open: purging is destructive and
 * irreversible, so it must never be reachable by a sales rep.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { requireStaff } from '../staff/auth.js';
import { purgeExpiredConversations, authorizePurge } from '../lib/retention.js';

const REGION = 'us-central1';

/**
 * Scheduled sweep.
 *
 * Timeout is raised well above the 60 s global default: a first run against a
 * database full of old conversations deletes in batches and can legitimately take
 * minutes. The job is resumable, so a timeout is recoverable, but there is no
 * reason to provoke one.
 *
 * `retryCount` is deliberately 0 on the scheduler and handled in-process instead:
 * a Cloud Scheduler retry re-runs a job that already partially succeeded, which
 * is safe here (idempotent) but would multiply the cost of a genuine failure.
 * Tomorrow's run picks up whatever is left.
 */
export const retentionPurge = onSchedule(
  {
    region: REGION,
    schedule: 'every day 03:00',
    timeZone: 'Etc/UTC',
    timeoutSeconds: 540,
    memory: '512MiB',
    retryCount: 0,
  },
  async () => {
    const result = await purgeExpiredConversations();
    // Structured log so an alert can key on it. Never log content — the whole
    // point of this job is that content stops existing.
    console.log(
      '[retention] purge complete',
      JSON.stringify({
        companiesScanned: result.companiesScanned,
        conversationsPurged: result.conversationsPurged,
        messagesDeleted: result.messagesDeleted,
        insightsDeleted: result.insightsDeleted,
        rateLimitsDeleted: result.rateLimitsDeleted,
        warnings: result.warnings,
      }),
    );
  },
);

const PurgeInput = z
  .object({
    /** Omit to sweep all companies (platform admin only). */
    companyId: z.string().min(1).max(200).optional(),
    dryRun: z.boolean().optional(),
  })
  .default({});

export const runRetentionPurge = onCall({ region: REGION, timeoutSeconds: 540 }, async (request) => {
  const identity = requireStaff(request);

  const parsed = PurgeInput.safeParse(request.data ?? {});
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid purge request');

  const { companyId, dryRun } = parsed.data;

  // The tenant boundary. The Admin SDK bypasses Firestore rules, so this decision
  // is the actual control that stops one customer's admin from deleting another's
  // data. Kept as a pure function in lib/retention.ts so the full matrix is unit
  // tested rather than assumed.
  const auth = authorizePurge({
    role: identity.role,
    callerCompanyId: identity.companyId,
    requestedCompanyId: companyId,
  });
  if (!auth.allowed) {
    throw new HttpsError(
      'permission-denied',
      auth.reason === 'cross_tenant' ? 'Cannot purge another company' : 'Insufficient role for this action',
    );
  }

  try {
    return await purgeExpiredConversations({ companyId: auth.targetCompanyId, dryRun });
  } catch (err) {
    console.error('[retention] callable purge failed', { err: (err as Error).message });
    throw new HttpsError('internal', 'Purge failed');
  }
});
