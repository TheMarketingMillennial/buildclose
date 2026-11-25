/**
 * Retention purge.
 *
 * Why this exists: the assistant records what a prospect says. That is somebody's
 * private commercial conversation, and the proposal page tells them so — "Your
 * conversation is recorded… Conversations are kept for N days." This job is what
 * makes that sentence true. Without it the disclosure is a claim we do not honour.
 *
 * WHAT IS DELETED, AND WHY EACH ONE
 *
 *   messages      Verbatim prospect and assistant text. The most sensitive thing
 *                 in the database. Hard deleted.
 *   insights      Model-derived inferences ABOUT that text ("prospect mentioned
 *                 incumbent is X", "price objection"). Still personal even though
 *                 no sentence survives, so it goes with the conversation.
 *   conversation  Kept, reduced to a tombstone. It never held content — only
 *                 companyId, proposalId, tokenId, counts and timestamps. Keeping
 *                 it preserves the conversation COUNT and engagement history that
 *                 the dashboard reports, so purging content does not silently
 *                 rewrite last quarter's numbers.
 *
 * WHAT IS DELIBERATELY NOT DELETED
 *
 *   acceptances   A signed acceptance is contract evidence. Destroying it on a
 *                 content-retention timer would be indefensible — statutory
 *                 record-keeping obligations for executed contracts outlast any
 *                 conversation retention window. Exempt, and the seller's
 *                 settings cannot override it.
 *   events        Content-free behavioural counts (view, click, message_sent).
 *                 These carry no conversation text; the only identifier is a
 *                 salted, one-way ipHash. They are the basis of the reported
 *                 conversion rate, so deleting them on a content timer would
 *                 make historical reporting lie. Out of scope by design.
 *   auditLog      Compliance trail. Never purged by this job.
 *   aiUsage       Cost metering, no content.
 *
 * Failure posture: purge is idempotent and resumable. Each conversation is
 * tombstoned only AFTER its contents are gone, so an interrupted run leaves work
 * for the next one instead of losing track of a half-purged conversation.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db, COLLECTIONS, FieldValue } from './firebase.js';
import { audit } from './audit.js';

/** Used when a company has no setting, or sets something unusable. */
export const DEFAULT_RETENTION_DAYS = 365;

/**
 * Floor for the setting.
 *
 * Defends against a company document that says `retentionDays: 0` (or a string,
 * or a negative). Honouring that literally would destroy every conversation the
 * moment the job ran, which is not a retention policy, it is data loss. A
 * misconfiguration must fail toward keeping data, not toward deleting it.
 */
export const MIN_RETENTION_DAYS = 30;

/** Firestore caps a batch at 500 writes; stay under it with headroom. */
const BATCH_SIZE = 400;

export interface PurgeOptions {
  /** Omit to sweep every company (the scheduled path). */
  companyId?: string;
  /** Count what would happen without writing anything. */
  dryRun?: boolean;
  /** Injectable clock, so tests are not hostage to the real date. */
  now?: Date;
}

export interface CompanyPurgeDetail {
  companyId: string;
  retentionDays: number;
  /** ISO timestamp of the cut-off actually applied. */
  cutoff: string;
  conversationsPurged: number;
  messagesDeleted: number;
  insightsDeleted: number;
}

export interface PurgeResult {
  dryRun: boolean;
  companiesScanned: number;
  conversationsPurged: number;
  messagesDeleted: number;
  insightsDeleted: number;
  rateLimitsDeleted: number;
  details: CompanyPurgeDetail[];
  /** Non-fatal problems, e.g. one company's settings were unusable. */
  warnings: string[];
}

/**
 * Turn a company's stored setting into a number this job is willing to act on.
 * Pure, so the clamp is unit-testable without touching Firestore.
 */
export function resolveRetentionDays(raw: unknown): { days: number; warning?: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { days: DEFAULT_RETENTION_DAYS, warning: `retentionDays missing or invalid (${String(raw)}); used ${DEFAULT_RETENTION_DAYS}` };
  }
  if (n < MIN_RETENTION_DAYS) {
    return { days: MIN_RETENTION_DAYS, warning: `retentionDays ${n} below the ${MIN_RETENTION_DAYS}-day floor; clamped` };
  }
  return { days: Math.floor(n) };
}

/** Delete a subcollection in bounded batches so one huge conversation cannot time out the run. */
async function deleteQueryBatched(
  query: FirebaseFirestore.Query,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    // A dry run must not write, so it cannot page by deleting: a `limit()` loop
    // over an unchanged result set would return the same documents forever.
    // One unbounded read is exact, and dry runs are operator-initiated rather
    // than scheduled, so the read cost is acceptable.
    const snap = await query.get();
    return snap.size;
  }

  let total = 0;
  for (;;) {
    const snap = await query.limit(BATCH_SIZE).get();
    if (snap.empty) break;
    total += snap.size;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    if (snap.size < BATCH_SIZE) break;
  }
  return total;
}

/**
 * Who may run a purge, and against which tenant.
 *
 * Pure and separate from the callable on purpose: this is the security decision,
 * and the Admin SDK bypasses Firestore rules, so this function IS the tenant
 * boundary. Keeping it a plain function means the matrix can be tested without
 * standing up an emulator or forging an ID token.
 */
export type PurgeAuthorization =
  | { allowed: true; targetCompanyId?: string }
  | { allowed: false; reason: 'insufficient_role' | 'cross_tenant' };

export function authorizePurge(input: {
  role: string;
  callerCompanyId: string;
  requestedCompanyId?: string;
}): PurgeAuthorization {
  const { role, callerCompanyId, requestedCompanyId } = input;

  if (role !== 'platform_admin' && role !== 'company_admin') {
    return { allowed: false, reason: 'insufficient_role' };
  }

  // A company admin is confined to their own tenant. Silently rewriting a
  // cross-tenant request to their own company would hide an attack attempt in
  // the logs, so this is refused outright.
  if (role === 'company_admin') {
    if (requestedCompanyId && requestedCompanyId !== callerCompanyId) {
      return { allowed: false, reason: 'cross_tenant' };
    }
    return { allowed: true, targetCompanyId: callerCompanyId };
  }

  // platform_admin may sweep everything (undefined) or name a tenant.
  return { allowed: true, ...(requestedCompanyId ? { targetCompanyId: requestedCompanyId } : {}) };
}

export async function purgeExpiredConversations(options: PurgeOptions = {}): Promise<PurgeResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();

  const result: PurgeResult = {
    dryRun,
    companiesScanned: 0,
    conversationsPurged: 0,
    messagesDeleted: 0,
    insightsDeleted: 0,
    rateLimitsDeleted: 0,
    details: [],
    warnings: [],
  };

  // ---- which companies ----
  let companies: Array<{ id: string; settings?: Record<string, unknown> }>;
  if (options.companyId) {
    const snap = await db.collection(COLLECTIONS.companies).doc(options.companyId).get();
    if (!snap.exists) throw new Error(`Company ${options.companyId} not found`);
    companies = [{ id: snap.id, settings: (snap.data()?.settings ?? {}) as Record<string, unknown> }];
  } else {
    const snap = await db.collection(COLLECTIONS.companies).limit(500).get();
    companies = snap.docs.map((d) => ({ id: d.id, settings: (d.data().settings ?? {}) as Record<string, unknown> }));
  }

  for (const company of companies) {
    result.companiesScanned += 1;

    const { days, warning } = resolveRetentionDays(company.settings?.retentionDays);
    if (warning) result.warnings.push(`${company.id}: ${warning}`);

    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const detail: CompanyPurgeDetail = {
      companyId: company.id,
      retentionDays: days,
      cutoff: cutoff.toISOString(),
      conversationsPurged: 0,
      messagesDeleted: 0,
      insightsDeleted: 0,
    };

    // Equality on companyId plus a range on lastMessageAt: served by the
    // (companyId ASC, lastMessageAt ASC) composite index in firestore.indexes.json.
    const expired = await db
      .collection(COLLECTIONS.conversations)
      .where('companyId', '==', company.id)
      .where('lastMessageAt', '<', Timestamp.fromDate(cutoff))
      .get();

    for (const conv of expired.docs) {
      const convId = conv.id;
      const convRef = conv.ref;

      /**
       * Skip tombstones.
       *
       * A purged conversation keeps its original `lastMessageAt` — that timestamp
       * is engagement history the dashboard still reports, so rewriting it to make
       * the query exclude the document would falsify the record. Which means the
       * query finds the same tombstone on every future run. Filtering here rather
       * than with a `where('status','!=',...)` clause keeps this off a composite
       * index and avoids reporting the same conversation as freshly purged (and
       * re-auditing it) once a day, forever.
       */
      if ((conv.data() as { status?: string }).status === 'purged') continue;

      detail.messagesDeleted += await deleteQueryBatched(
        convRef.collection(COLLECTIONS.messages),
        dryRun,
      );
      detail.insightsDeleted += await deleteQueryBatched(
        db.collection(COLLECTIONS.insights).where('conversationId', '==', convId),
        dryRun,
      );
      detail.conversationsPurged += 1;

      if (!dryRun) {
        // Tombstone LAST. If the run dies mid-conversation the record still looks
        // un-purged, so the next run retries it rather than skipping it.
        await convRef.update({
          status: 'purged',
          messageCount: 0,
          purgedAt: FieldValue.serverTimestamp(),
          retentionDays: days,
        });
      }
    }

    result.conversationsPurged += detail.conversationsPurged;
    result.messagesDeleted += detail.messagesDeleted;
    result.insightsDeleted += detail.insightsDeleted;
    result.details.push(detail);
  }

  // ---- rate-limit documents are pure bookkeeping and carry an expiry ----
  result.rateLimitsDeleted = await deleteQueryBatched(
    db.collection(COLLECTIONS.rateLimits).where('expiresAt', '<', Timestamp.fromDate(now)),
    dryRun,
  );

  if (!dryRun && (result.conversationsPurged > 0 || result.rateLimitsDeleted > 0)) {
    // Audit per company that actually lost data, so the trail answers
    // "what did we destroy, for whom, under which policy".
    for (const d of result.details) {
      if (d.conversationsPurged === 0) continue;
      await audit({
        companyId: d.companyId,
        action: 'retention.purged',
        actorType: 'system',
        detail: {
          conversations: d.conversationsPurged,
          messages: d.messagesDeleted,
          insights: d.insightsDeleted,
          retentionDays: d.retentionDays,
          cutoff: d.cutoff,
        },
      });
    }
  }

  return result;
}
