import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { defaultAgentForLane, type Lane } from "@/server/agents/registry";
import { audit } from "@/server/auth/audit";
import { startRun } from "./startRun";

// Lane progression. Terminal is 'pr' — not agent-driven (Approve & PR button).
const NEXT: Record<Lane, Lane | null> = {
  brainstorm: "plan",
  plan: "review",
  review: "pr",
  // PR → Implement is a manual click, not auto-advance. Human should
  // review the PR docs before agents start writing code.
  pr: null,
  implement: null,
};

/**
 * Called by spawnAgent.finalize() on status='completed'. Spawns the next
 * lane's default agent unless:
 *   - the terminal lane (`pr`) was just reached
 *   - the next lane has no default agent (shouldn't happen today)
 *   - the task has been archived between start and finalize
 *
 * Safe to run in the child-exit handler because it does its own DB reads
 * and spawn; errors are logged but never thrown.
 */
export async function maybeAutoAdvance(runId: string): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.status !== "completed") return;

  const currentLane = run.lane as Lane;
  const nextLane = NEXT[currentLane];
  if (!nextLane || nextLane === "pr") return;

  const nextAgent = defaultAgentForLane(nextLane);
  if (!nextAgent) return;

  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (!task || task.status === "archived") return;

  try {
    const r = await startRun({
      taskId: run.taskId,
      lane: nextLane,
      agentId: nextAgent,
      initiator: { kind: "auto_advance" },
      // Auto-advance can fire very quickly after the manual click, so skip
      // the 10s idempotency window that exists for user double-click guards.
      bypassIdempotency: true,
    });
    audit({
      action: "run.auto_advanced",
      taskId: run.taskId,
      runId: r.runId,
      payload: { from_lane: currentLane, to_lane: nextLane, from_run_id: runId },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auto_advance] failed", { runId, currentLane, nextLane, err });
    audit({
      action: "run.auto_advance_failed",
      taskId: run.taskId,
      runId,
      payload: {
        from_lane: currentLane,
        to_lane: nextLane,
        error: String((err as Error).message ?? err),
      },
    });
  }
}
