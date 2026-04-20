import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { runRegistry } from "@/server/worker/runRegistry";
import { removeWorktreeForTask } from "@/server/git/worktree";

export const runtime = "nodejs";

export const GET = withAuth(async ({ req }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFound("task not found");
  return { task };
});

export const DELETE = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can archive a task");
  }
  if (task.status === "archived") {
    // Idempotent — already archived. Nothing to do.
    return { ok: true, alreadyArchived: true };
  }

  // 1. Stop any live runs for this task (SIGTERM → 5s → SIGKILL).
  const liveRunRows = db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, id))
    .all();
  let stoppedCount = 0;
  for (const r of liveRunRows) {
    const handle = runRegistry.get(r.id);
    if (handle) {
      handle.stop("shutdown");
      stoppedCount++;
    }
  }

  // 2. Remove the worktree from disk (best-effort; logs warnings).
  const { removed, warnings } = await removeWorktreeForTask(id);

  // 3. Mark the task archived. Runs / messages / artifacts are retained so
  //    the audit trail stays intact. A future `DELETE /api/admin/tasks/:id`
  //    route could hard-delete, but that's an admin-only escape hatch.
  const now = new Date();
  db.update(tasks)
    .set({ status: "archived", updatedAt: now, currentRunId: null })
    .where(eq(tasks.id, id))
    .run();

  audit({
    action: "task.archived",
    actorUserId: user.id,
    taskId: id,
    payload: {
      jiraKey: task.jiraKey,
      stoppedLiveRuns: stoppedCount,
      worktreeRemoved: removed,
      worktreeWarnings: warnings,
    },
  });

  return {
    ok: true,
    taskId: id,
    stoppedLiveRuns: stoppedCount,
    worktreeRemoved: removed,
    worktreeWarnings: warnings,
  };
});
