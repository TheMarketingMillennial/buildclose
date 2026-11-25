/**
 * Versioned model pricing so historical cost never shifts when rates change.
 *
 * Amounts are USD per 1,000,000 tokens. `PRICING_VERSION` is written onto every
 * aiUsage record; recomputing an old month uses the table version stored on the
 * record, not the current constants.
 */

export const PRICING_VERSION = '2026-11-01';

interface ModelRate {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

/**
 * Conservative defaults. These are seeded from published list prices and are
 * reconciled against real invoices; see docs/COSTS.md. Unknown models fall back
 * to the highest rate in the table so a new model cannot silently under-meter.
 */
const RATES: Record<string, ModelRate> = {
  'gpt-6.1-sol': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-6-luna': { inputPerMillion: 1.0, outputPerMillion: 4 },
  'gpt-5.4': { inputPerMillion: 2.0, outputPerMillion: 8 },
  'gpt-5.4-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
};

const FALLBACK: ModelRate = { inputPerMillion: 5, outputPerMillion: 15 };

export interface CostBreakdown {
  costMicroUsd: number; // integer micro-dollars to avoid float drift
  pricingVersion: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export function computeCost(model: string, promptTokens: number, completionTokens: number): CostBreakdown {
  const rate = RATES[model] ?? FALLBACK;
  const usd = (promptTokens / 1_000_000) * rate.inputPerMillion + (completionTokens / 1_000_000) * rate.outputPerMillion;
  return {
    costMicroUsd: Math.round(usd * 1_000_000),
    pricingVersion: PRICING_VERSION,
    inputPerMillion: rate.inputPerMillion,
    outputPerMillion: rate.outputPerMillion,
  };
}

export function microUsdToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}
