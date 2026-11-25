/**
 * Firestore-backed fixed-window rate limiter.
 *
 * Chosen over an in-memory counter because Cloud Run scales horizontally: a
 * per-instance map would let a caller multiply their allowance by hitting
 * different instances. One document per key keeps the collection bounded.
 */
import { db, COLLECTIONS, FieldValue } from './firebase.js';

export interface Limit {
  /** Stable, scoped key, e.g. `chat:proposal123:ip:abc`. */
  key: string;
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfter: number;
}

/**
 * Consume one unit of quota. Fails closed on infrastructure error so a database
 * blip cannot silently disable abuse protection.
 */
export async function consume(limits: Limit[]): Promise<LimitResult> {
  const results: LimitResult[] = [];
  for (const l of limits) {
    results.push(await consumeOne(l));
  }
  // Strictest limit wins.
  const blocked = results.filter((r) => !r.allowed);
  if (blocked.length > 0) {
    const worst = blocked.reduce((a, b) => (a.retryAfter > b.retryAfter ? a : b));
    return { allowed: false, remaining: 0, retryAfter: worst.retryAfter };
  }
  return {
    allowed: true,
    remaining: Math.min(...results.map((r) => r.remaining)),
    retryAfter: 0,
  };
}

async function consumeOne(l: Limit): Promise<LimitResult> {
  const ref = db.collection(COLLECTIONS.rateLimits).doc(safeDocId(l.key));
  const now = Date.now();

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as { count?: number; windowStart?: number }) : null;
      const windowStart = data?.windowStart ?? 0;
      const elapsed = now - windowStart;

      if (!data || elapsed >= l.windowSec * 1000) {
        tx.set(ref, {
          key: l.key,
          count: 1,
          windowStart: now,
          expiresAt: new Date(now + l.windowSec * 1000),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { allowed: true, remaining: l.limit - 1, retryAfter: 0 };
      }

      const count = data.count ?? 0;
      if (count >= l.limit) {
        const retryAfter = Math.max(1, Math.ceil((l.windowSec * 1000 - elapsed) / 1000));
        return { allowed: false, remaining: 0, retryAfter };
      }

      tx.update(ref, { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      return { allowed: true, remaining: l.limit - count - 1, retryAfter: 0 };
    });
  } catch {
    // Fail closed: deny rather than permit on limiter failure.
    return { allowed: false, remaining: 0, retryAfter: 30 };
  }
}

/** Firestore document ids allow a limited character set. */
function safeDocId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 400);
}
