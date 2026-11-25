/**
 * Commercial response validation.
 *
 * Requirement 5: commercially sensitive output is validated before display. The
 * prompt forbids improvisation, but a prompt is a request, not a control. This
 * module is the control.
 *
 * Design decision — negation awareness. A naive "reject any unapproved figure"
 * rule produces a bad failure mode: the *correct* answer to "can you do $18,000?"
 * is "I can't offer $18,000, the total is fixed at $24,000." Blocking that
 * punishes the model for doing exactly what it was told, and replaces a good
 * refusal with a generic hand-off.
 *
 * So an unapproved amount is only a violation when it is *asserted* rather than
 * *declined*. We look in a short window before the figure for negation or
 * fixed-price framing. The check still fails closed: absent an explicit negation,
 * any unapproved figure blocks the reply.
 */
import { extractAmountsMinor } from './domain.js';

export interface CommercialPolicy {
  totalValueMinor: number;
  commencementMinor: number;
  /** Pre-approved concession amounts the agent may actually offer. */
  approvedAmountsMinor: number[];
  /** Published figures the agent may quote without implying a concession. */
  quotableAmountsMinor?: number[];
  currency: 'USD';
}

export interface CommercialVerdict {
  ok: boolean;
  /** Figures asserted that are not approved. */
  violations: number[];
  reason?: 'unauthorised_amount' | 'discount_language' | 'commitment_language';
}

/** Every figure a reply may state at all. */
function quotable(p: CommercialPolicy): Set<number> {
  const s = new Set<number>([p.totalValueMinor, p.commencementMinor]);
  for (const a of p.approvedAmountsMinor) s.add(a);
  for (const q of p.quotableAmountsMinor ?? []) s.add(q);
  return s;
}

/** Frames that mark a figure as being declined or corrected rather than offered. */
const NEGATION_FRAME =
  /\b(can(?:'|no)?t|cannot|can not|won't|will not|wouldn't|not able to|unable to|not authorised|not authorized|isn't possible|is not possible|no discount|not in a position to|fixed at|fixed price|set at|remain(?:s)? at|stays? at|total of|comes? to|no room)\b[^.!?]{0,80}$/i;

const COMMITMENT_PATTERNS: RegExp[] = [
  /\bwe\s+guarantee\b/i,
  /\bguaranteed?\s+(return|result|outcome|saving|revenue|roi|income)\b/i,
  /\bI\s+can\s+promise\b/i,
  /\bwe\s+will\s+(refund|waive)\b/i,
  /\bI(?:'ve|\s+have)\s+(approved|authorised|authorized)\b/i,
  /\bcontract\s+is\s+(now\s+)?(binding|signed|executed)\b/i,
  /\byour\s+(proposal|offer)\s+is\s+(accepted)\b/i,
  /\bno\s+charge\b/i,
  /\bwe\s+will\s+absolutely\b/i,
];

/** Language that offers a concession. Requires an approved discount to be present. */
const DISCOUNT_PATTERNS: RegExp[] = [
  /\b(?:I|we)\s+can\s+(?:do|offer)\s+\$/i,
  /\bhow\s+about\s+\$/i,
  /\bmeet\s+you\s+at\b/i,
  /\bknock\s+(?:\$[\d,]+|\w+)\s+off\b/i,
  /\bI(?:'ll|\s+will)\s+(?:reduce|lower|discount)\b/i,
];

/**
 * Does the text immediately before this figure frame it as declined or fixed?
 * Returns true when the figure is being negated, so it is not an assertion.
 */
function isNegatedAt(reply: string, index: number): boolean {
  // Look back a bounded window; long enough for a clause, short enough to not
  // accidentally attribute an earlier clause's negation to this figure.
  const start = Math.max(0, index - 160);
  const before = reply.slice(start, index);
  // Only the final clause before the figure is relevant.
  const clause = before.split(/[.!?;]/).pop() ?? before;
  return NEGATION_FRAME.test(clause);
}

export function validateCommercial(reply: string, policy: CommercialPolicy): CommercialVerdict {
  const allowed = quotable(policy);

  // Re-extract with positions so each figure's framing can be inspected.
  const violations: number[] = [];
  const re = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const raw = (m[1] ?? '').replace(/,/g, '');
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    const minor = Math.round(value * 100);
    if (allowed.has(minor)) continue;
    // Unapproved figure: only a problem if it is presented as an offer.
    if (!isNegatedAt(reply, m.index)) violations.push(minor);
  }

  if (violations.length > 0) {
    return { ok: false, violations, reason: 'unauthorised_amount' };
  }

  // A concession may only be described if a concession is actually authorised.
  if (policy.approvedAmountsMinor.length === 0 && DISCOUNT_PATTERNS.some((r) => r.test(reply))) {
    return { ok: false, violations: [], reason: 'discount_language' };
  }

  if (COMMITMENT_PATTERNS.some((r) => r.test(reply))) {
    return { ok: false, violations: [], reason: 'commitment_language' };
  }

  return { ok: true, violations: [] };
}

/**
 * Safe fallback when validation fails. Does not echo the offending text, and hands
 * off to a human rather than exposing an internal correction.
 */
export function safeFallbackReply(): string {
  return "I want to make sure I give you accurate figures, so I'd rather not answer that from memory. Let me connect you with your representative, who can confirm the exact terms.";
}

/**
 * Observational heuristic for prompt-extraction attempts. The real defence is the
 * prompt architecture plus validation above; this exists so attempts are logged
 * and visible in the dashboard rather than silent.
 */
export function looksLikeInjection(message: string): boolean {
  const patterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    /system\s+prompt/i,
    /reveal\s+your\s+(instructions|rules|prompt)/i,
    /you\s+are\s+now\s+(a|an)\b/i,
    /disregard\s+(your|all)\s+(rules|guidelines)/i,
    /repeat\s+(the\s+)?(text|words)\s+above/i,
    /print\s+(your\s+)?(instructions|prompt|rules)/i,
  ];
  return patterns.some((re) => re.test(message));
}

/** Exported for tests so the negation heuristic can be verified directly. */
export const __test = { isNegatedAt, extractAmountsMinor };
