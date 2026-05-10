import { eq, and, desc } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { postComment } from "./client";
import { env } from "@/server/lib/env";
import { currentCycleNumber } from "@/server/lib/taskCycle";
import {
  buildImplementationShipNote,
  extractShipNoteSections,
} from "./shipNote";

/**
 * Post a Jira comment summarising a QA-fix cycle's pushed implementation.
 * Called by `implementComplete` when the run-finalising path detects
 * this task is in a QA fix cycle (`isTaskInQaFixCycle`).
 *
 * Delegates to the shared shipNote renderer (cycleNumber > 1 swaps the
 * heading to "QA fix pushed — round N"). Same body as cycle 1's
 * `implementCommentDoc`, just a different heading. The PR description
 * rewrite in Step 1c writes byte-identical content.
 *
 * Mirrors `postAmendmentComment` shape — best-effort, never throws.
 */
export async function postQaFixComment(opts: {
  runId: string;
  taskId: string;
  prUrl: string;
  branch: string;
  commits: Array<{ sha: string; subject: string }>;
}): Promise<void> {
  if (!env.JIRA_BASE_URL || !env.JIRA_API_TOKEN) return;

  const { runId, taskId, prUrl, branch, commits } = opts;
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;

  // Cycle number is the number of brainstorm runs (cycle 2+ on QA-fix).
  // Fallback to currentCycleNumber from taskCycle to keep the source of
  // truth in one place.
  const cycleNumber = currentCycleNumber(taskId);

  // Pull the latest implementation artifact + parse its sections.
  const latestImpl = db
    .select({ markdown: artifacts.markdown })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, "implementation")))
    .orderBy(desc(artifacts.createdAt))
    .limit(1)
    .get();
  const sections = extractShipNoteSections(latestImpl?.markdown ?? "");

  const shipNote = buildImplementationShipNote({
    jiraKey: task.jiraKey,
    title: task.title,
    prUrl,
    branch,
    commits,
    sections,
    cycleNumber,
  });

  try {
    const commentId = await postComment(task.jiraKey, shipNote.adf);
    audit({
      action: "jira.qa_fix_comment_posted",
      taskId,
      runId,
      payload: {
        commentId,
        jiraKey: task.jiraKey,
        cycleNumber,
        prUrl,
        sectionsComplete: sections.complete,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[jira] qa-fix comment failed", {
      runId,
      taskId,
      error: (err as Error).message,
    });
    audit({
      action: "jira.qa_fix_comment_failed",
      taskId,
      runId,
      payload: { error: (err as Error).message },
    });
  }
}
