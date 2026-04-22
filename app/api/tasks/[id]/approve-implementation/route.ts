import { and, desc, eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Conflict, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { auditLog, runs, tasks } from "@/server/db/schema";
import { implementComplete } from "@/server/git/implementComplete";
import { withRunLock } from "@/server/worker/chatMutex";
import { audit } from "@/server/auth/audit";

export const runtime = "nodejs";

/**
 * POST /api/tasks/:id/approve-implementation
 *
 * Human gate between "agent finished implementing" and "server commits + pushes
 * + comments on Jira + transitions status + moves lane to done". The agent
 * itself writes no commits — this endpoint is the ONLY path that produces the
 * implementation commit.
 *
 * Preconditions:
 *   - caller is the card owner or admin
 *   - latest implement run for this task has status='completed'
 *   - no prior `task.implementation_complete` audit row (already approved)
 */
export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/approve-implementation — id is two before the last segment
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can approve");
  }

  // Already approved? Short-circuit so double-clicks are idempotent.
  const alreadyApproved = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, "task.implementation_complete"),
      ),
    )
    .limit(1)
    .get();
  if (alreadyApproved) {
    return {
      ok: true,
      alreadyApproved: true,
      message: "implementation already finalised",
    };
  }

  // Find the most recent completed implement run.
  const run = db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.lane, "implement")))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  if (!run) throw new Conflict("no implement run on this task");
  if (run.status !== "completed") {
    throw new Conflict(
      `implement run must be completed before approval (currently ${run.status})`,
    );
  }

  audit({
    action: "implement.approved",
    actorUserId: user.id,
    taskId,
    runId: run.id,
  });

  const result = await withRunLock(`approve-implementation:${taskId}`, () =>
    implementComplete(run.id, taskId),
  );
  return result;
});
