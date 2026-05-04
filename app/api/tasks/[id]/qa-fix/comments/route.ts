import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
} from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { getIssueComments } from "@/server/jira/client";
import { lastImplementationCompleteAt } from "@/server/lib/taskCycle";

export const runtime = "nodejs";

/**
 * GET /api/tasks/:id/qa-fix/comments
 *
 * Returns Jira comments created AFTER the most recent
 * `task.implementation_complete` audit row for this task. Used by the
 * `Fix from QA` modal's checkbox picker — the operator selects which
 * comments are actual QA findings (vs. questions, manager nudges, etc.)
 * before spawning the fix cycle.
 *
 * Returns 409 if the task isn't on the `done` lane (the QA-fix flow
 * is only meaningful from `done`). Returns an empty `comments` array
 * when Jira creds are missing — the modal surfaces a "Jira unreachable"
 * empty state.
 */
export const GET = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/qa-fix/comments — id is three before 'comments'
  const taskId = segments[segments.length - 3];
  if (!taskId) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can fetch QA comments");
  }
  if (task.currentLane !== "done") {
    throw new Conflict(
      `Fix from QA only available on done-lane cards (current: ${task.currentLane})`,
    );
  }

  const doneAt = lastImplementationCompleteAt(taskId);
  if (!doneAt) {
    // Lane is `done` but we have no implementation_complete audit row.
    // This shouldn't happen in normal flow — return empty so the modal
    // shows a "no QA comments yet" state rather than confusing the user
    // with a 500.
    return { comments: [], doneAt: null };
  }

  const allComments = await getIssueComments(task.jiraKey);
  const sinceDone = allComments.filter((c) => {
    if (!c.created) return false;
    const ts = Date.parse(c.created);
    return Number.isFinite(ts) && ts > doneAt.getTime();
  });

  return {
    comments: sinceDone,
    doneAt: doneAt.toISOString(),
  };
});
