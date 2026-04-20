import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound, Conflict } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { runRegistry } from "@/server/worker/runRegistry";

export const runtime = "nodejs";

export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/runs/[id]/stop — id is two before 'stop'
  const runId = segments[segments.length - 2];
  if (!runId) throw new BadRequest("missing run id");

  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new NotFound("run not found");

  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can stop a run");
  }

  const handle = runRegistry.get(runId);
  if (!handle) {
    // Not alive in this process — it's either already finalised or a stale
    // row from a prior process. Don't try to kill anything.
    throw new Conflict(`run ${runId} is not active (status=${run.status})`);
  }

  handle.stop("user");
  audit({
    action: "run.stopped",
    actorUserId: user.id,
    taskId: run.taskId,
    runId,
    payload: { initiated_by: "user" },
  });

  return { ok: true, runId };
});
