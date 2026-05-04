import { eq, isNull, and } from "drizzle-orm";
import { z } from "zod";
import { withAuth } from "@/server/lib/route";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
} from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { startRun } from "@/server/worker/startRun";
import { getIssueComments } from "@/server/jira/client";
import { lastImplementationCompleteAt } from "@/server/lib/taskCycle";

export const runtime = "nodejs";

const RequestBody = z.object({
  qaCommentIds: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * POST /api/tasks/:id/qa-fix/start
 *
 * Spawns a fresh `ce:brainstorm` run with the operator-selected Jira
 * comments as input, kicking off a QA-fix cycle. The cascade
 * (auto-advance) carries it through to `review`; the operator then
 * uses the existing Approve & PR + Implement + Approve Implementation
 * gates (Layer B's cycle-aware versions) to push the fix.
 *
 * Validation order (cheap-to-expensive):
 *   1. body shape (zod)
 *   2. task exists + owner/admin gate
 *   3. task on `done` lane
 *   4. no other run currently active for this task
 *   5. all submitted commentIds are in the fresh comments-since-done
 *      set (re-fetches Jira so a deleted-since-modal-opened comment
 *      doesn't slip through)
 */
export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/qa-fix/start — id is three before 'start'
  const taskId = segments[segments.length - 3];
  if (!taskId) throw new BadRequest("missing task id");

  const body = RequestBody.parse(await req.json());

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can start a QA fix");
  }
  if (task.currentLane !== "done") {
    throw new Conflict(
      `Fix from QA only available on done-lane cards (current: ${task.currentLane})`,
    );
  }

  // Block if any run is currently active for this task.
  const activeRun = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.status, "running"),
        isNull(runs.supersededAt),
      ),
    )
    .limit(1)
    .get();
  if (activeRun) {
    throw new Conflict(`a run is already active for this task (${activeRun.id})`);
  }

  // Re-fetch comments to validate selection against fresh state. The
  // modal may have been open for a while; comments could have been
  // edited or deleted in Jira in the interim.
  const doneAt = lastImplementationCompleteAt(taskId);
  if (!doneAt) {
    throw new Conflict(
      "task is on done lane but no implementation_complete audit row found",
    );
  }
  const allComments = await getIssueComments(task.jiraKey);
  const validIds = new Set(
    allComments
      .filter((c) => {
        if (!c.created) return false;
        const ts = Date.parse(c.created);
        return Number.isFinite(ts) && ts > doneAt.getTime();
      })
      .map((c) => c.id),
  );
  for (const id of body.qaCommentIds) {
    if (!validIds.has(id)) {
      throw new BadRequest(
        `comment ${id} is not in the comments-since-done set (was it deleted?)`,
      );
    }
  }

  const result = await startRun({
    taskId,
    lane: "brainstorm",
    agentId: "ce:brainstorm",
    qaFixCycle: true,
    qaCommentIds: body.qaCommentIds,
    initiator: { userId: user.id, kind: "user" },
  });

  return { ok: true, runId: result.runId };
});
