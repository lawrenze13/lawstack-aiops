import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { runRegistry } from "./runRegistry";

/**
 * Boot-time crash recovery. Any run row left as `running` whose id is NOT
 * currently in the in-memory runRegistry is truly orphaned — the process
 * owning it has died. Mark those `interrupted`.
 *
 * Runs currently in the registry are alive in THIS process (spawnAgent just
 * added them), so we must skip them — otherwise an HMR-triggered re-run of
 * this function would wipe live runs.
 */
export function reconcileInterruptedRuns(): void {
  const liveIds = Array.from(runRegistry.keys());

  const whereClause =
    liveIds.length > 0
      ? and(eq(runs.status, "running"), notInArray(runs.id, liveIds))
      : eq(runs.status, "running");

  const stuck = db.select({ id: runs.id }).from(runs).where(whereClause).all();
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
  console.warn(
    `[reconcile] marked ${stuck.length} run(s) as interrupted on boot (${liveIds.length} live in this process preserved)`,
  );
}
