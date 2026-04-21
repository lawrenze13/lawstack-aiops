import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { approveAndPr } from "@/server/git/approve";
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

  // Reuse the run-lock machinery keyed on taskId to serialise concurrent
  // Approve clicks from two tabs.
  const result = await withRunLock(`approve:${taskId}`, () => approveAndPr(taskId, user.id));
  return result;
});
