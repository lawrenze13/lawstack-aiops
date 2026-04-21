// Nightly maintenance job. Run via `tsx server/cron/nightly.ts` from a
// systemd timer. Keeps the SQLite DB compact and the worktree root from
// growing unbounded.
//
// Operations:
//   1. Prune `messages` older than 90 days — frees space from completed
//      runs. audit_log is never pruned.
//   2. Remove on-disk worktrees for tasks that are archived + old.
//   3. Weekly (Sundays) wal_checkpoint(TRUNCATE) to reclaim WAL file space.
//   4. Log a summary line per operation.

import { and, eq, inArray, lt } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { db, sqlite } from "@/server/db/client";
import { messages, runs, tasks, worktrees } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";

const DAY_MS = 24 * 60 * 60 * 1000;
const MESSAGE_RETENTION_DAYS = 90;
const WORKTREE_ARCHIVED_GRACE_DAYS = 1;

function log(op: string, detail: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", cron: "nightly", op, ...detail }));
}

function pruneOldMessages(): number {
  const cutoff = new Date(Date.now() - MESSAGE_RETENTION_DAYS * DAY_MS);
  const res = db.delete(messages).where(lt(messages.createdAt, cutoff)).run();
  const deleted = Number(res.changes ?? 0);
  if (deleted > 0) {
    audit({
      action: "cron.prune_messages",
      payload: { deleted, olderThanDays: MESSAGE_RETENTION_DAYS },
    });
  }
  return deleted;
}

async function removeStaleWorktrees(): Promise<{ removed: number; skipped: number }> {
  // Archived tasks whose worktree row is still 'live' and was last touched
  // more than GRACE days ago.
  const cutoff = new Date(Date.now() - WORKTREE_ARCHIVED_GRACE_DAYS * DAY_MS);
  const candidates = db
    .select({
      path: worktrees.path,
      taskId: worktrees.taskId,
      lastUsedAt: worktrees.lastUsedAt,
    })
    .from(worktrees)
    .innerJoin(tasks, eq(tasks.id, worktrees.taskId))
    .where(
      and(
        eq(worktrees.status, "live"),
        eq(tasks.status, "archived"),
        lt(worktrees.lastUsedAt, cutoff),
      ),
    )
    .all();

  let removed = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      if (existsSync(c.path)) {
        await rm(c.path, { recursive: true, force: true });
      }
      db.update(worktrees)
        .set({ status: "removed" })
        .where(eq(worktrees.taskId, c.taskId))
        .run();
      removed++;
      audit({
        action: "cron.worktree_pruned",
        taskId: c.taskId,
        payload: { path: c.path },
      });
    } catch (err) {
      skipped++;
      // eslint-disable-next-line no-console
      console.warn("[cron] worktree prune failed", { path: c.path, err });
    }
  }
  return { removed, skipped };
}

function dropOrphanRunRowsForPrunedMessages(): number {
  // After pruning messages, some runs become pointing-at-nothing. We don't
  // delete them (runs rows are cheap; we keep cost/audit history) but we
  // DO null out `last_heartbeat_at` so they don't show up in admin "stuck
  // runs" queries. Low-priority cleanup.
  const res = sqlite
    .prepare(
      `UPDATE runs
         SET last_heartbeat_at = NULL
       WHERE status != 'running'
         AND last_heartbeat_at IS NOT NULL
         AND id NOT IN (SELECT DISTINCT run_id FROM messages)`,
    )
    .run();
  return res.changes ?? 0;
}

function weeklyCheckpointIfSunday(): boolean {
  const isSunday = new Date().getDay() === 0;
  if (!isSunday) return false;
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  audit({ action: "cron.wal_checkpoint", payload: { mode: "TRUNCATE" } });
  return true;
}

async function main(): Promise<void> {
  const start = Date.now();

  const messagesDeleted = pruneOldMessages();
  log("prune_messages", { deleted: messagesDeleted });

  const worktreeResult = await removeStaleWorktrees();
  log("prune_worktrees", worktreeResult);

  const runsNulled = dropOrphanRunRowsForPrunedMessages();
  log("null_heartbeat_on_orphans", { rows: runsNulled });

  const didCheckpoint = weeklyCheckpointIfSunday();
  log("weekly_checkpoint", { ran: didCheckpoint });

  log("done", { durationMs: Date.now() - start });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({ level: "error", cron: "nightly", error: (err as Error).message }),
  );
  process.exit(1);
});
