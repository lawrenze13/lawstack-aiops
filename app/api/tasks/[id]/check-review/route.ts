import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { checkReviewVerdict } from "@/server/git/reviewVerdict";

export const runtime = "nodejs";

/**
 * POST /api/tasks/:id/check-review
 *
 * Fetches the task's PR comments, scans for a `REVIEW_RESULT: …` line
 * written by the CI code-review workflow, and records the verdict to
 * audit_log. Idempotent: once a verdict is recorded, further calls
 * short-circuit and return the cached state.
 *
 * Called from the client on a 30s poll while the state is "pending".
 * Also safe to call from a server-side cron or webhook later without
 * changing any contracts.
 */
export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can check review state");
  }

  const state = await checkReviewVerdict(taskId);
  return { state };
});
