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
import { auditLog, prRecords, runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { env } from "@/server/lib/env";
import { postComment } from "@/server/jira/client";
import { paragraph, strong, code, link, doc, heading, type AdfBlockNode } from "@/server/jira/adf";

export const runtime = "nodejs";

const RequestBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/tasks/:id/skip-tests
 *
 * Operator escape hatch for the test lane. Records a `test.skipped`
 * audit row, posts a Jira comment explaining the skip, and moves the
 * lane to `done`. Used when Playwright is misbehaving for non-code
 * reasons (flaky CI, infra outage, browser install failure unrelated
 * to the diff under test) and the operator decides shipping is safe.
 *
 * Auth: owner-or-admin (matches Approve Implementation, Fix from QA).
 * Gating: only valid on `currentLane === "test"`. No active-run check
 * because the test run that just failed (or hung) has already
 * released its `currentRunId`; if a new run is somehow active we
 * still allow the skip — the operator's action wins.
 */
export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/skip-tests — id is two before path tail
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const body = RequestBody.parse(await req.json().catch(() => ({})));

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can skip tests");
  }
  if (task.currentLane !== "test") {
    throw new Conflict(
      `Skip Tests only available on test-lane cards (current: ${task.currentLane})`,
    );
  }

  const pr = db.select().from(prRecords).where(eq(prRecords.taskId, taskId)).limit(1).get();

  // Move lane + audit in one transaction so a crash between them can't
  // leave a "lane=done with no skip audit" row (mirrors the same
  // pattern in implementComplete Step 4 + testComplete Step 4).
  db.transaction((tx) => {
    tx.update(tasks)
      .set({ currentLane: "done", currentRunId: null, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .run();
    tx.insert(auditLog)
      .values({
        action: "test.skipped",
        actorUserId: user.id,
        taskId,
        runId: null,
        payloadJson: JSON.stringify({ reason: body.reason ?? null }),
      })
      .run();
  });

  // Best-effort Jira comment. A skip without a Jira note would leave
  // QA wondering why the ticket transitioned silently.
  if (env.JIRA_BASE_URL && pr?.prUrl) {
    try {
      const blocks: AdfBlockNode[] = [
        heading(2, "⏭️ Tests skipped"),
        paragraph(
          strong("Branch: "),
          code(pr.branch ?? "(unknown)"),
          "  ",
          strong("PR: "),
          link(pr.prUrl, pr.prUrl),
        ),
        paragraph(
          "An operator manually skipped the post-implement Playwright run for this ticket. ",
          "The card has been moved to ",
          code("done"),
          ".",
        ),
      ];
      if (body.reason) {
        blocks.push(paragraph(strong("Reason: "), body.reason));
      }
      const commentId = await postComment(task.jiraKey, doc(blocks));
      audit({
        action: "jira.test_skip_comment_posted",
        taskId,
        runId: null,
        payload: { commentId },
      });
    } catch (err) {
      // Non-fatal; the lane move + audit are the source of truth.
      audit({
        action: "jira.test_skip_comment_failed",
        taskId,
        runId: null,
        payload: { error: (err as Error).message },
      });
    }
  }

  return { ok: true };
});
