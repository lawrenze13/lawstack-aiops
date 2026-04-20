// Hard-coded USD-per-token prices for Claude models. These change; update
// whenever Anthropic publishes new pricing. Intentionally not hidden in
// env — wrong values cause silent overcharge, so they should be code-reviewed.
//
// Source: https://www.anthropic.com/pricing#api (verify on swap)
// Format: USD per million input/output tokens. Prompt-cache reads are
// typically 10% of base input; cache writes are 25% premium. We use the
// conservative base rates since stream-json usage blocks already break
// these out but our math is close enough for a $5/$15 guardrail.

export type PriceRow = {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
};

// Prices in USD per 1,000,000 tokens.
const PRICES: Record<string, PriceRow> = {
  "claude-opus-4-7": {
    inputPerM: 15,
    outputPerM: 75,
    cacheReadPerM: 1.5,
    cacheWritePerM: 18.75,
  },
  "claude-sonnet-4-6": {
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75,
  },
  "claude-haiku-4-5-20251001": {
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheWritePerM: 1.25,
  },
};

const FALLBACK: PriceRow = PRICES["claude-sonnet-4-6"]!;

export function priceFor(model: string): PriceRow {
  // Exact match first, then prefix (e.g. 'claude-sonnet-4-6-20260401').
  if (PRICES[model]) return PRICES[model]!;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key]!;
  }
  // eslint-disable-next-line no-console
  console.warn(`[pricing] no price for model ${model}; falling back to sonnet rates`);
  return FALLBACK;
}

export type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Compute incremental USD for a single usage snapshot. */
export function costForUsage(model: string, usage: UsageLike): number {
  const p = priceFor(model);
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (inTok * p.inputPerM +
      outTok * p.outputPerM +
      cacheRead * p.cacheReadPerM +
      cacheWrite * p.cacheWritePerM) /
    1_000_000
  );
}
