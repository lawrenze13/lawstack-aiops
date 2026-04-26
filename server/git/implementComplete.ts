import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, auditLog, prRecords, tasks, worktrees } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { env } from "@/server/lib/env";
import { implementCommentDoc } from "@/server/jira/adf";
import { robustPush } from "@/server/git/push";
import { makeRunContext } from "@/server/worker/runContext";
import {
  isCredentialsInvalid,
  markRunCredentialsInvalid,
  reasonFor,
} from "@/server/worker/credentialsFailure";
import { redactSecrets } from "@/server/lib/redactSecrets";

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
  // Per-task creds drive Jira identity for the comment + transition.
  const ctx = makeRunContext(task.ownerId);
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
            `user.email=${ctx.creds.git.value.email}`,
            "-c",
            `user.name=${ctx.creds.git.value.name}`,
            "commit",
            "-m",
            message,
          ],
          { cwd: wt.path },
        );
      }
      // robustPush handles: idempotent no-op when nothing's unpushed,
      // missing upstream (-u), and non-fast-forward (fetch + rebase +
      // retry). The rebase case happens when the remote has advanced
      // between the agent's last fetch and this final push — common if
      // a prior Approve run pushed, or implementation was retried from
      // a stale worktree.
      try {
        const res = await robustPush(wt.path, pr.branch);
        pushed = true;
        if (res.rebased) {
          warnings.push("rebased onto origin before push");
        }
      } catch (err) {
        return {
          ok: false,
          failedAt: "safety_push",
          error: `git push failed: ${(err as Error).message}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        failedAt: "safety_push",
        error: `commit + push failed: ${(err as Error).message}`,
      };
    }
  }

  // ─── Step 1b: undraft the PR ─────────────────────────────────────────
  // The PR was opened as DRAFT during Approve & PR (planning stage) to
  // hold the brainstorm/plan/review docs without triggering the CI code
  // review on doc-only changes. Now that real implementation commits are
  // pushed, marking the PR ready dispatches a `ready_for_review` event
  // which the `claude-review` workflow listens for — kicking off the
  // automated review + Jira transition to "Ready for QA" (or "Failed
  // Code Review"). Idempotent: `gh pr ready` on a non-draft PR is a
  // no-op that returns 0.
  if (wt?.path && !hasPriorAudit(taskId, "pr.marked_ready")) {
    try {
      await exec("gh", ["pr", "ready", pr.branch], { cwd: wt.path });
      audit({
        action: "pr.marked_ready",
        taskId,
        runId,
        payload: { branch: pr.branch },
      });
      // Signal the post-PR review as pending. The UI's ReviewVerdictBadge
      // polls /api/tasks/:id/check-review and flips to the verdict once
      // the CI workflow posts its REVIEW_RESULT comment.
      audit({
        action: "review.pending",
        taskId,
        runId,
        payload: { branch: pr.branch, prUrl: pr.prUrl },
      });
    } catch (err) {
      warnings.push(`gh pr ready failed: ${(err as Error).message}`);
    }
  }

  // Collect commits for the Jira comment.
  const commits = await getCommitsSinceMain(wt?.path);

  // ─── Step 2: Jira implementation comment ─────────────────────────────
  let jiraCommentId: string | null = null;
  const priorCommentPosted = hasPriorAudit(taskId, "jira.implement_comment_posted");
  if (priorCommentPosted) {
    warnings.push("implementation comment already posted; skipping");
  } else if (!ctx.jiraClient) {
    warnings.push("Jira credentials not configured; skipping comment");
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
      jiraCommentId = await ctx.jiraClient.postComment(task.jiraKey, body);
      audit({
        action: "jira.implement_comment_posted",
        taskId,
        runId,
        payload: { commentId: jiraCommentId, commits: commits.length },
      });
    } catch (err) {
      // Detect typed CredentialsInvalidError so /admin/ops shows a key
      // icon and the owning user gets a notification via run.failed.
      if (isCredentialsInvalid(err)) {
        markRunCredentialsInvalid({
          runId,
          taskId,
          service: err.service,
          err,
        });
        return {
          ok: false,
          failedAt: "implementation_comment",
          error: reasonFor(err.service),
        };
      }
      return {
        ok: false,
        failedAt: "implementation_comment",
        error: `Jira comment failed: ${redactSecrets((err as Error).message)}`,
      };
    }
  }

  // ─── Step 3: Jira transition → Code Review ───────────────────────────
  const priorTransitioned = hasPriorAudit(taskId, "jira.code_review_transitioned");
  let transitioned = false;
  if (priorTransitioned) {
    warnings.push("already transitioned to review status; skipping");
  } else if (ctx.jiraClient) {
    try {
      const match = await ctx.jiraClient.transitionIssueToName(
        task.jiraKey,
        env.JIRA_REVIEW_STATUS,
      );
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
      // Non-fatal for the transition step (the PR + comment are the
      // real handoff). But still mark + audit credentials_invalid so
      // the owner sees a notification — they need to update /profile.
      if (isCredentialsInvalid(err)) {
        markRunCredentialsInvalid({ runId, taskId, service: err.service, err });
      }
      warnings.push(
        `Jira transition failed: ${redactSecrets((err as Error).message)}`,
      );
      audit({
        action: "jira.code_review_transition_failed",
        taskId,
        runId,
        payload: { error: redactSecrets((err as Error).message) },
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
    "Implementation generated by LawStack/aiops ce:work agent.\n" +
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
