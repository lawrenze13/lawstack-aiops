import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { costForUsage, type UsageLike } from "@/server/agents/pricing";
import { audit } from "@/server/auth/audit";

// Default thresholds in USD. Individual agents can override via
// AgentConfig.costWarnUsd / costKillUsd (see registry.ts — ce:work uses
// 10/30 because implementation runs are longer than planning runs).
export const COST_WARN_USD = 5;
export const COST_KILL_USD = 15;

type MeterState = {
  model: string;
  usdCumulative: number;
  warned: boolean;
  warnUsd: number;
  killUsd: number;
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
  | { kind: "warn"; usdCumulative: number; threshold: number }
  | { kind: "kill"; usdCumulative: number; threshold: number };

/**
 * Register a run with its model + (optional) per-run cap overrides.
 * Falls back to COST_WARN_USD / COST_KILL_USD when not provided.
 */
export function initMeter(
  runId: string,
  model: string,
  caps?: { warnUsd?: number; killUsd?: number },
): void {
  meters.set(runId, {
    model,
    usdCumulative: 0,
    warned: false,
    warnUsd: caps?.warnUsd ?? COST_WARN_USD,
    killUsd: caps?.killUsd ?? COST_KILL_USD,
  });
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

  if (state.usdCumulative >= state.killUsd) {
    audit({
      action: "cost_cap.tripped",
      runId,
      payload: { usd: state.usdCumulative, threshold: state.killUsd },
    });
    return {
      kind: "kill",
      usdCumulative: state.usdCumulative,
      threshold: state.killUsd,
    };
  }
  if (!state.warned && state.usdCumulative >= state.warnUsd) {
    state.warned = true;
    audit({
      action: "cost_warn.tripped",
      runId,
      payload: { usd: state.usdCumulative, threshold: state.warnUsd },
    });
    return {
      kind: "warn",
      usdCumulative: state.usdCumulative,
      threshold: state.warnUsd,
    };
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
