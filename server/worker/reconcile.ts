import "server-only";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";

/**
 * Boot-time crash recovery.
 *
 * History lesson (see commits d82d31a, 81db6c5, ec10591, and this one):
 *
 *   v1 — use runRegistry.has(runId) to skip live runs.
 *        Bug: INSERT happens before registry.set; reconcile in that gap
 *        wrongly flagged live rows.
 *
 *   v2 — use process.uptime() as source of truth; only orphan rows whose
 *        started_at predates process boot.
 *        Bug: Next.js dev spawns short-lived worker processes (static page
 *        analysis, etc.) that each load db/client.ts, each get their own
 *        globalThis, each run reconcile with tiny uptime. Real live runs
 *        from the main server get false-positive'd as orphans.
 *
 *   v3 (this) — use an absolute-age cutoff. A truly orphaned run has
 *               status='running' AND is very old (hours). A currently-
 *               active run in any Node process is always young. Flag only
 *               rows older than ORPHAN_AGE_MS.
 *
 * Downside: if a run genuinely crashes mid-flight (e.g., Node OOM), the
 * UI will show it as still "running" for up to ORPHAN_AGE_MS before the
 * reconciler catches it. In practice the cost cap ($15 hard kill) and
 * explicit Stop button provide faster paths to finalization, so the
 * slow reconciler is fine as a last-resort sweep.
 */
const ORPHAN_AGE_MS = 60 * 60 * 1000; // 1 hour

export function reconcileInterruptedRuns(): void {
  const now = Date.now();
  const cutoff = new Date(now - ORPHAN_AGE_MS);

  const stuck = db
    .select({ id: runs.id, startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, cutoff)))
    .all();

  if (stuck.length === 0) return;

  const nowDate = new Date(now);
  db.transaction((tx) => {
    for (const r of stuck) {
      tx.update(runs)
        .set({
          status: "interrupted",
          killedReason: "server_restart",
          finishedAt: nowDate,
        })
        .where(eq(runs.id, r.id))
        .run();
      audit({
        action: "run.interrupted",
        runId: r.id,
        payload: {
          reason: "server_restart",
          startedAt: r.startedAt,
          ageMs: now - new Date(r.startedAt).getTime(),
        },
      });
    }
  });

  // eslint-disable-next-line no-console
  console.warn(
    `[reconcile] marked ${stuck.length} run(s) as interrupted (older than ${
      ORPHAN_AGE_MS / 1000
    }s)`,
  );
}
