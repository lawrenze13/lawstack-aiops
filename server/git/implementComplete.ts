import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, auditLog, prRecords, tasks, worktrees } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { env } from "@/server/lib/env";
import {
  postComment,
  transitionIssueToName,
} from "@/server/jira/client";
import { implementCommentDoc } from "@/server/jira/adf";

const exec = promisify(execFile);

type Step =
  | "safety_push"
  | "implementation_comment"
  | "code_review_transition"
  | "lane_to_done";

export type ImplementCompleteResult =
  | {
      ok: true;
      pushed: boolean;
      commitsPosted: number;
      jiraCommentId: string | null;
      transitioned: boolean;
      warnings: string[];
    }
  | { ok: false; failedAt: Step; error: string };

/**
 * Runs after ce:work exits with status='completed'. Pushes any residual
 * work, posts a Jira comment summarising what was built, transitions
 * the ticket to Code Review, and moves the task to the 'done' lane.
 *
 * Audit-log dedupe on every external effect so a double-finalise race
 * (rare, but possible under reconciler + manual kill) doesn't spam.
 *
 * Rollback semantics: on any step failure, DO NOT move the lane to
 * 'done'. Emit an audit row with the failure, return { ok: false, ... }
 * so the caller can surface it. The card stays at 'implement' with a
 * visible problem.
 */
export async function implementComplete(
  runId: string,
  taskId: string,
): Promise<ImplementCompleteResult> {
  const warnings: string[] = [];

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    return { ok: false, failedAt: "safety_push", error: "task not found" };
  }
  const wt = db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).limit(1).get();
  if (!wt || wt.status !== "live") {
    // No worktree — nothing to push. Skip to Jira steps with empty commits.
    warnings.push("worktree not live; safety push skipped");
  }

  // Read the PR record — we need the URL for the Jira comment.
  const pr = db.select().from(prRecords).where(eq(prRecords.taskId, taskId)).limit(1).get();
  if (!pr?.prUrl) {
    return {
      ok: false,
      failedAt: "implementation_comment",
      error: "no PR url recorded on this task; cannot post implementation comment",
    };
  }

  // ─── Step 1: commit + push the agent's work ──────────────────────────
  //
  // The agent is instructed NOT to commit during Implement — it leaves
  // changes in the working tree. This step stages them all, builds ONE
  // clean commit with a ticket-referencing message, and pushes.
  //
  // If the agent violated the contract and already committed, the
  // `git status --porcelain` check returns empty and we just push
  // whatever commits exist. Safe either way.
  let pushed = false;
  if (wt?.path) {
    try {
      const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], {
        cwd: wt.path,
      });
      if (statusOut.trim().length > 0) {
        await exec("git", ["add", "-A"], { cwd: wt.path });
        const message = buildCommitMessage(task.jiraKey, task.title);
        await exec(
          "git",
          [
            "-c",
            "user.email=ai-ops@multiportal.io",
            "-c",
            "user.name=multiportal-ai-ops",
            "commit",
            "-m",
            message,
          ],
          { cwd: wt.path },
        );
      }
      // Push is idempotent when nothing's unpushed.
      try {
        await exec("git", ["push"], { cwd: wt.path });
        pushed = true;
      } catch (pushErr) {
        // If the remote is ahead or branch upstream is missing, try a
        // set-upstream push. Fail the step if that also errors.
        try {
          await exec("git", ["push", "-u", "origin", pr.branch], { cwd: wt.path });
          pushed = true;
        } catch (err) {
          return {
            ok: false,
            failedAt: "safety_push",
            error: `git push failed: ${(err as Error).message || String(pushErr)}`,
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        failedAt: "safety_push",
        error: `commit + push failed: ${(err as Error).message}`,
      };
    }
  }

  // Collect commits for the Jira comment.
  const commits = await getCommitsSinceMain(wt?.path);

  // ─── Step 2: Jira implementation comment ─────────────────────────────
  let jiraCommentId: string | null = null;
  const priorCommentPosted = hasPriorAudit(taskId, "jira.implement_comment_posted");
  if (priorCommentPosted) {
    warnings.push("implementation comment already posted; skipping");
  } else if (!env.JIRA_BASE_URL) {
    warnings.push("JIRA_BASE_URL not configured; skipping comment");
  } else {
    try {
      const implementationMarkdown = await getImplementationMarkdown(taskId);
      const body = implementCommentDoc({
        prUrl: pr.prUrl,
        jiraKey: task.jiraKey,
        title: task.title,
        commits,
        implementationMarkdown,
      });
      jiraCommentId = await postComment(task.jiraKey, body);
      audit({
        action: "jira.implement_comment_posted",
        taskId,
        runId,
        payload: { commentId: jiraCommentId, commits: commits.length },
      });
    } catch (err) {
      return {
        ok: false,
        failedAt: "implementation_comment",
        error: `Jira comment failed: ${(err as Error).message}`,
      };
    }
  }

  // ─── Step 3: Jira transition → Code Review ───────────────────────────
  const priorTransitioned = hasPriorAudit(taskId, "jira.code_review_transitioned");
  let transitioned = false;
  if (priorTransitioned) {
    warnings.push("already transitioned to review status; skipping");
  } else if (env.JIRA_BASE_URL && env.JIRA_API_TOKEN) {
    try {
      const match = await transitionIssueToName(task.jiraKey, env.JIRA_REVIEW_STATUS);
      if (match) {
        transitioned = true;
        audit({
          action: "jira.code_review_transitioned",
          taskId,
          runId,
          payload: {
            to: env.JIRA_REVIEW_STATUS,
            transitionId: match.id,
            transitionName: match.name,
          },
        });
      } else {
        warnings.push(
          `Jira transition to "${env.JIRA_REVIEW_STATUS}" not available from current state`,
        );
        audit({
          action: "jira.code_review_transition_skipped",
          taskId,
          runId,
          payload: { to: env.JIRA_REVIEW_STATUS },
        });
      }
    } catch (err) {
      // Non-fatal: the PR + comment are the real handoff. Log a warning
      // and keep going.
      warnings.push(`Jira transition failed: ${(err as Error).message}`);
      audit({
        action: "jira.code_review_transition_failed",
        taskId,
        runId,
        payload: { error: (err as Error).message },
      });
    }
  }

  // ─── Step 4: move task lane to 'done' ────────────────────────────────
  try {
    db.update(tasks)
      .set({ currentLane: "done", updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .run();
    audit({
      action: "task.implementation_complete",
      taskId,
      runId,
      payload: { pushed, commits: commits.length, transitioned },
    });
  } catch (err) {
    return {
      ok: false,
      failedAt: "lane_to_done",
      error: `lane update failed: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    pushed,
    commitsPosted: commits.length,
    jiraCommentId,
    transitioned,
    warnings,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function buildCommitMessage(jiraKey: string, title: string): string {
  // Subject kept under ~72 chars where possible.
  const subject = `feat(${jiraKey}): ${title}`;
  const trimmedSubject = subject.length > 72 ? subject.slice(0, 71) + "…" : subject;
  return (
    trimmedSubject +
    "\n\n" +
    "Implementation generated by multiportal-ai-ops ce:work agent.\n" +
    "See docs/implementation/" +
    jiraKey +
    "-implementation.md for the per-file summary.\n" +
    "See docs/plans/" +
    jiraKey +
    "-plan.md and docs/reviews/" +
    jiraKey +
    "-review.md for the planning context."
  );
}


function hasPriorAudit(taskId: string, action: string): boolean {
  const row = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.taskId, taskId), eq(auditLog.action, action)))
    .limit(1)
    .get();
  return !!row;
}

async function getCommitsSinceMain(
  worktreePath: string | undefined,
): Promise<Array<{ sha: string; subject: string }>> {
  if (!worktreePath) return [];
  try {
    const { stdout } = await exec(
      "git",
      ["log", "origin/main..HEAD", "--pretty=%h%x09%s"],
      { cwd: worktreePath },
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha: sha ?? "", subject: rest.join("\t") };
    });
  } catch {
    return [];
  }
}

async function getImplementationMarkdown(taskId: string): Promise<string | undefined> {
  const row = db
    .select({ markdown: artifacts.markdown })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, "implementation")))
    .orderBy(desc(artifacts.createdAt))
    .limit(1)
    .get();
  return row?.markdown;
}
