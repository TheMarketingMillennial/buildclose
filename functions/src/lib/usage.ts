/**
 * Concurrency-safe usage accounting.
 *
 * THE BUG THIS EXISTS TO CLOSE.
 *
 * The first version of the guards did what almost every SaaS does first: count
 * the existing rows, compare to the limit, then write. That is a TOCTOU race. Five
 * simultaneous `createProposal` calls on a plan of one each read "0 active
 * proposals", each concludes it is the first, and all five are created. The same
 * shape applies to seats and to the AI budget, where the consequence is worse
 * because parallel prospect messages can each pass the budget check and then all
 * spend.
 *
 * WHY A COUNTER DOCUMENT RATHER THAN A TRANSACTIONAL QUERY.
 *
 * A transaction that re-runs the count does not fix this. Firestore transactions
 * are optimistic and take read locks on the documents they RETURN — if a query
 * currently matches nothing, there is no document to lock, so two transactions
 * can both insert and both commit. This is the classic phantom-insert gap.
 *
 * A single counter document DOES fix it, because every competing writer both reads
 * and writes the SAME document. Two concurrent transactions therefore conflict, one
 * retries, and the retry sees the first one's increment. That document is the
 * serialisation point.
 *
 * WHY RESERVE → COMMIT → RELEASE, RATHER THAN ONE TRANSACTION.
 *
 * The work that follows the check is not transactable: creating a Firebase Auth
 * user, or calling OpenAI. So the counter is incremented optimistically
 * ("reserved"), the slow thing happens outside any transaction, and then the
 * reservation is either committed or released. A crash between reserve and commit
 * leaks a reservation, which is why every reservation is also bounded in time and
 * why `reconcile` exists.
 */
import { db, COLLECTIONS, FieldValue } from './firebase.js';

/** A held reservation. Call exactly one of `commit()` / `release()`. */
export interface Reservation {
  commit: () => Promise<void>;
  release: () => Promise<void>;
  /** True once committed or released, so a double-settle is a no-op. */
  settled: () => boolean;
}

export interface LimitOutcome {
  allowed: boolean;
  /** Live usage after the reservation, for the refusal message. */
  used: number;
}

const counterRef = (companyId: string) => db.collection(COLLECTIONS.usageCounters).doc(companyId);

/**
 * Reserve a unit of a monotonic resource (a seat, an active-proposal slot).
 *
 * `limit === null` means unlimited: no counter is touched, because maintaining a
 * counter nobody enforces is pure cost and a source of drift.
 *
 * `seedCount` is the true number of live rows, read by the caller immediately
 * before this call. It is used ONLY when the counter has never been initialised —
 * so an existing tenant with three proposals is not retroactively given a fresh
 * allowance of three. Because seeding happens inside the transaction, two
 * concurrent first-time callers cannot both seed: the second conflicts, retries,
 * and finds the counter already initialised.
 */
async function reserveUnit(
  companyId: string,
  field: 'seatsCommitted' | 'proposalsCommitted',
  seedField: 'seatsSeeded' | 'proposalsSeeded',
  seedCount: number,
  limit: number | null,
): Promise<{ outcome: LimitOutcome; reservation: Reservation }> {
  if (limit === null) {
    return {
      outcome: { allowed: true, used: seedCount },
      reservation: {
        commit: async () => undefined,
        release: async () => undefined,
        settled: () => true,
      },
    };
  }

  let settled = false;
  const ref = counterRef(companyId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists ? snap.data() : {}) as Record<string, unknown>;

    const seeded = data[seedField] === true;
    const current = seeded ? Number(data[field] ?? 0) : seedCount;

    if (current + 1 > limit) {
      // Do not write on a refusal: a denied request must not mutate state.
      return { allowed: false, used: current };
    }

    tx.set(
      ref,
      {
        companyId,
        [field]: current + 1,
        [seedField]: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { allowed: true, used: current + 1 };
  });

  const owner = result.allowed;

  const settle = async (delta: number) => {
    if (!owner || settled) return;
    settled = true;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() as Record<string, unknown>;
      const current = Number(data[field] ?? 0);
      tx.set(ref, { [field]: Math.max(0, current + delta) }, { merge: true });
    });
  };

  return {
    outcome: result,
    reservation: {
      // The increment IS the commit for a creation that succeeds, so there is
      // nothing left to do.
      commit: async () => {
        settled = true;
      },
      // A failed creation gives the slot back.
      release: () => settle(-1),
      settled: () => settled,
    },
  };
}

/** Release a slot when the thing occupying it is archived or deleted. */
async function releaseUnit(
  companyId: string,
  field: 'seatsCommitted' | 'proposalsCommitted',
): Promise<void> {
  const ref = counterRef(companyId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() as Record<string, unknown>;
    const current = Number(data[field] ?? 0);
    if (current <= 0) return;
    tx.set(ref, { [field]: current - 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

// ------------------------------------------------------------------- seats

export async function reserveSeat(
  companyId: string,
  limit: number | null,
  liveUserCount: number,
): Promise<{ outcome: LimitOutcome; reservation: Reservation }> {
  return reserveUnit(companyId, 'seatsCommitted', 'seatsSeeded', liveUserCount, limit);
}

export async function releaseSeatOnRemoval(companyId: string): Promise<void> {
  return releaseUnit(companyId, 'seatsCommitted');
}

// ------------------------------------------------------------- proposals

/**
 * Reserve an active-proposal slot.
 *
 * `liveActiveCount` must count draft + published only, matching the rule the pure
 * module applies. Archived proposals are finished work and hold no slot — which is
 * why `archiveProposal` releases one.
 */
export async function reserveProposalSlot(
  companyId: string,
  limit: number | null,
  liveActiveCount: number,
): Promise<{ outcome: LimitOutcome; reservation: Reservation }> {
  return reserveUnit(companyId, 'proposalsCommitted', 'proposalsSeeded', liveActiveCount, limit);
}

export async function releaseProposalSlot(companyId: string): Promise<void> {
  return releaseUnit(companyId, 'proposalsCommitted');
}

// -------------------------------------------------------------- AI budget

const aiCounterRef = (companyId: string, monthKey: string) =>
  db.collection(COLLECTIONS.usageCounters).doc(`ai__${companyId}__${monthKey}`);

export interface AiReservation {
  /**
   * Close the reservation, charging `actualMicro` (the real cost of the call) and
   * returning whatever was reserved but not spent. Omitting the argument charges
   * the full worst-case reservation, which is the safe default: a caller that
   * cannot report a precise cost must not be given money back.
   */
  commit: (actualMicro?: number) => Promise<void>;
  /** Close the reservation charging nothing (the call never happened). */
  release: () => Promise<void>;
}

export interface AiLimitOutcome {
  allowed: boolean;
  /** Micro-dollars already spent plus what is currently reserved. */
  committedMicro: number;
  budgetMicro: number;
}

/**
 * Reserve the WORST-CASE cost of one model call.
 *
 * Reserving the maximum and settling to the actual is what makes concurrent
 * prospect messages safe: each message must first own budget it might spend, so
 * twenty simultaneous requests cannot all observe "budget remaining" and then all
 * spend it. Any unused reservation is returned on settle.
 *
 * `baselineMicro` is the sum of already-recorded `aiUsage` cost for the month,
 * supplied by the caller when the counter has never been initialised. It exists so
 * deploying this code does not hand every tenant a fresh full allowance mid-month.
 */
export async function reserveAiBudget(
  companyId: string,
  monthKey: string,
  budgetUsd: number | null,
  reservationMicro: number,
  baselineMicro: number,
): Promise<{ outcome: AiLimitOutcome; reservation: AiReservation }> {
  const ref = aiCounterRef(companyId, monthKey);
  const budgetMicro = budgetUsd === null ? Number.POSITIVE_INFINITY : Math.round(budgetUsd * 1_000_000);

  let settled = false;

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists ? snap.data() : {}) as Record<string, unknown>;

    const seeded = data.seeded === true;
    const spentMicro = seeded ? Number(data.spentMicro ?? 0) : baselineMicro;
    const reservedMicro = seeded ? Number(data.reservedMicro ?? 0) : 0;
    const committed = spentMicro + reservedMicro;

    if (budgetMicro !== Number.POSITIVE_INFINITY && committed + reservationMicro > budgetMicro) {
      return { allowed: false, committedMicro: committed, budgetMicro };
    }

    tx.set(
      ref,
      {
        companyId,
        monthKey,
        seeded: true,
        // When seeding, the baseline is folded into spentMicro so future reads are
        // self-contained.
        spentMicro,
        reservedMicro: reservedMicro + reservationMicro,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { allowed: true, committedMicro: committed + reservationMicro, budgetMicro };
  });

  const settle = async (actualMicro: number) => {
    if (!result.allowed || settled) return;
    settled = true;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() as Record<string, unknown>;
      const reserved = Number(data.reservedMicro ?? 0);
      const spent = Number(data.spentMicro ?? 0);
      tx.set(
        ref,
        {
          // Return what was not used; charge what was.
          reservedMicro: Math.max(0, reserved - reservationMicro),
          spentMicro: spent + Math.max(0, actualMicro),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  };

  return {
    outcome: result,
    reservation: {
      commit: (actualMicro?: number) => settle(actualMicro ?? reservationMicro),
      release: () => settle(0),
    },
  };
}
