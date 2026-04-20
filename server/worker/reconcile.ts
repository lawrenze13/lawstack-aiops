import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";

/**
 * Boot-time crash recovery. Any run row left as `running` after a server
 * restart had no PID to track and is therefore lost. We mark it `interrupted`
 * with a reason; the UI will surface a `Resume` button (Phase 2) that spawns
 * a fresh child resuming the same `claude_session_id`.
 *
 * Phase 1: no live runs exist yet, so this is a no-op. Phase 2 wires the
 * runRegistry reconciliation (PID liveness checks, orphan-process sweep).
 */
export function reconcileInterruptedRuns(): void {
  const stuck = db.select({ id: runs.id }).from(runs).where(eq(runs.status, "running")).all();
  if (stuck.length === 0) return;

  const now = Date.now();
  db.transaction((tx) => {
    for (const r of stuck) {
      tx.update(runs)
        .set({
          status: "interrupted",
          killedReason: "server_restart",
          finishedAt: new Date(now),
        })
        .where(eq(runs.id, r.id))
        .run();
      audit({ action: "run.interrupted", runId: r.id, payload: { reason: "server_restart" } });
    }
  });

  // eslint-disable-next-line no-console
  console.warn(`[reconcile] marked ${stuck.length} run(s) as interrupted on boot`);
}
