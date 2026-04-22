import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { worktrees } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { env } from "@/server/lib/env";

const exec = promisify(execFile);

export type RemoteCleanupResult = {
  prClosed: boolean;
  remoteBranchDeleted: boolean;
  warnings: string[];
};

/**
 * Close the PR attached to `branch` (if any) and delete the branch on
 * `origin`. Called from the archive DELETE route when the user ticks
 * "also delete remote branch".
 *
 * Uses the task's worktree as the working copy for `gh` / `git push`
 * (that's the only place with a configured remote for this branch).
 * Each step is best-effort — a failure on the PR close doesn't block
 * the branch delete, and neither blocks the local archive path.
 */
export async function deleteRemoteBranchAndClosePr(
  taskId: string,
  branch: string,
  prUrl: string | null,
): Promise<RemoteCleanupResult> {
  const warnings: string[] = [];
  let prClosed = false;
  let remoteBranchDeleted = false;

  const wt = db
    .select({ path: worktrees.path, status: worktrees.status })
    .from(worktrees)
    .where(eq(worktrees.taskId, taskId))
    .get();
  // If the worktree's gone we can still try from the BASE_REPO — `gh` and
  // `git push` work anywhere the remote is configured.
  const cwd =
    wt && wt.status !== "removed" && existsSync(wt.path)
      ? wt.path
      : env.BASE_REPO;
  if (!cwd) {
    warnings.push("no worktree and BASE_REPO unset; cannot reach remote");
    return { prClosed, remoteBranchDeleted, warnings };
  }

  // Step 1: close the PR, if one exists. Branch deletion alone would
  // auto-close a PR, but closing explicitly gives us a useful comment
  // anchor and surfaces failures cleanly.
  if (prUrl) {
    try {
      await exec(
        "gh",
        [
          "pr",
          "close",
          branch,
          "--comment",
          "Closed via multiportal-ai-ops archive.",
        ],
        { cwd },
      );
      prClosed = true;
      audit({
        action: "pr.closed_on_archive",
        taskId,
        payload: { branch, prUrl },
      });
    } catch (err) {
      // Common reasons: PR already closed/merged, gh not authed for this
      // repo. Not fatal — proceed to branch delete.
      warnings.push(`gh pr close failed: ${(err as Error).message}`);
    }
  }

  // Step 2: delete the remote branch. `git push origin --delete <branch>`
  // is idempotent-ish: returns non-zero if the branch doesn't exist on
  // origin, which we treat as already-deleted.
  try {
    await exec("git", ["push", "origin", "--delete", branch], { cwd });
    remoteBranchDeleted = true;
    audit({
      action: "git.remote_branch_deleted",
      taskId,
      payload: { branch },
    });
  } catch (err) {
    const msg = (err as Error).message || "";
    if (/remote ref does not exist|deleted successfully/i.test(msg)) {
      // Already gone — treat as success, no warning.
      remoteBranchDeleted = true;
    } else {
      warnings.push(`git push --delete failed: ${msg}`);
    }
  }

  return { prClosed, remoteBranchDeleted, warnings };
}
