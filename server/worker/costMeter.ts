import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { costForUsage, type UsageLike } from "@/server/agents/pricing";
import { audit } from "@/server/auth/audit";

// Thresholds in USD. Admin-configurable post-MVP; hard-coded for now.
export const COST_WARN_USD = 5;
export const COST_KILL_USD = 15;

type MeterState = {
  model: string;
  usdCumulative: number;
  warned: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __costMeters: Map<string, MeterState> | undefined;
}

const meters: Map<string, MeterState> = globalThis.__costMeters ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__costMeters = meters;
}

export type MeterOutcome =
  | { kind: "ok"; usdCumulative: number }
  | { kind: "warn"; usdCumulative: number }
  | { kind: "kill"; usdCumulative: number };

/** Register a run with its model so subsequent observeUsage calls can price it. */
export function initMeter(runId: string, model: string): void {
  meters.set(runId, { model, usdCumulative: 0, warned: false });
}

/**
 * Observe a `message.usage` block from an assistant stream event and update
 * the running total. Returns an outcome the caller uses to fan out events
 * (warn toast, hard-kill the child).
 *
 * Claude's usage blocks are *cumulative for the turn* — they re-report the
 * same numbers on each delta. To avoid double-counting, we reset on each
 * observed usage and replace the total for that turn. This is approximate
 * but good enough for a soft-cap guardrail; the final `result` event has
 * the authoritative total_cost_usd we reconcile against.
 */
export function observeAssistantUsage(runId: string, usage: UsageLike): MeterOutcome {
  const state = meters.get(runId);
  if (!state) return { kind: "ok", usdCumulative: 0 };

  const thisTurn = costForUsage(state.model, usage);
  // Running total for the *run*, summed across assistant messages. The usage
  // block on each assistant turn is that turn's totals; we add them as they arrive.
  state.usdCumulative += thisTurn;

  // Persist coarse-grained: write DB every call (cheap; int micros).
  try {
    db.update(runs)
      .set({ costUsdMicros: Math.round(state.usdCumulative * 1_000_000) })
      .where(eq(runs.id, runId))
      .run();
  } catch {
    // ignore
  }

  if (state.usdCumulative >= COST_KILL_USD) {
    audit({
      action: "cost_cap.tripped",
      runId,
      payload: { usd: state.usdCumulative, threshold: COST_KILL_USD },
    });
    return { kind: "kill", usdCumulative: state.usdCumulative };
  }
  if (!state.warned && state.usdCumulative >= COST_WARN_USD) {
    state.warned = true;
    audit({
      action: "cost_warn.tripped",
      runId,
      payload: { usd: state.usdCumulative, threshold: COST_WARN_USD },
    });
    return { kind: "warn", usdCumulative: state.usdCumulative };
  }
  return { kind: "ok", usdCumulative: state.usdCumulative };
}

/** Reconcile against the authoritative `result` event total. */
export function finalizeMeter(runId: string, finalUsd: number): void {
  const state = meters.get(runId);
  if (!state) return;
  try {
    db.update(runs)
      .set({ costUsdMicros: Math.round(finalUsd * 1_000_000) })
      .where(eq(runs.id, runId))
      .run();
  } catch {
    // ignore
  }
  meters.delete(runId);
}

export function clearMeter(runId: string): void {
  meters.delete(runId);
}
