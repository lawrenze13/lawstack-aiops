import "server-only";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";

/**
 * Boot-time crash recovery.
 *
 * Previous approach (trust runRegistry) had a race: the DB row is INSERTed
 * in startRun BEFORE spawnAgent populates the registry. If reconcile fires
 * in that gap (slow dynamic import, HMR weirdness), the live row looks
 * orphaned and gets wrongly marked interrupted.
 *
 * New approach: a run is truly orphaned iff its `started_at` predates
 * THIS process's boot time. We compute boot time from process.uptime()
 * at the moment reconcile runs — anything older than that is from a
 * process that's no longer with us. Anything newer is mine (or about
 * to be mine) and must be left alone.
 *
 * The 2-second grace window accounts for the tiny delay between
 * `process.uptime()` starting to tick and the first row INSERT.
 */
const BOOT_GRACE_MS = 2000;

export function reconcileInterruptedRuns(): void {
  const now = Date.now();
  const processBootedAt = now - Math.round(process.uptime() * 1000);
  const cutoff = new Date(processBootedAt - BOOT_GRACE_MS);

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
          processBootedAt: new Date(processBootedAt),
        },
      });
    }
  });

  // eslint-disable-next-line no-console
  console.warn(
    `[reconcile] marked ${stuck.length} run(s) as interrupted (started before process boot at ${new Date(
      processBootedAt,
    ).toISOString()})`,
  );
}
