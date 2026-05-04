import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { approveAndPr } from "@/server/git/approve";
import { approveCycle } from "@/server/git/approveCycle";
import { currentCycleNumber } from "@/server/lib/taskCycle";
import { withRunLock } from "@/server/worker/chatMutex";

export const runtime = "nodejs";

export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/approve — id is two before 'approve'
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can approve");
  }

  // Cycle dispatch happens INSIDE the lock — not at the top of this
  // handler — so a concurrent brainstorm POST (different lock key) can't
  // race-flip the cycle number between our read and the lock acquisition.
  // (Deepen-plan finding: data-integrity SEV-1.)
  return await withRunLock(`approve:${taskId}`, async () => {
    const cycle = currentCycleNumber(taskId);
    if (cycle > 1) {
      // Cycle N>1 — push the latest brainstorm/plan/review onto the
      // existing PR. No "PR opened" Jira comment (cycle 1 already
      // posted that). The implementation comment from the upcoming
      // ce:work + Approve Implementation flow is what closes the cycle.
      return await approveCycle(taskId, user.id);
    }
    return await approveAndPr(taskId, user.id);
  });
});
