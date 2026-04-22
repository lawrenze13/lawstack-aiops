import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { worktrees } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { Conflict, AppError } from "@/server/lib/errors";

const exec = promisify(execFile);

// `<JIRA-KEY>-ai` (suffix, not prefix). Two reasons:
//   1. The CI code-review workflow extracts the Jira key via the regex
//      `^[A-Z]+-[0-9]+` anchored at start of branch. A prefixed name
//      (`ai/MP-389`) doesn't match — the key extraction silently fails
//      and the Jira transition step is skipped.
//   2. Still keeps AI-generated branches disambiguated from a human
//      working directly on `MP-389`.
const BRANCH_SUFFIX = "-ai";

export type WorktreeInfo = {
  path: string;
  branch: string;
};

/**
 * Idempotently provision a git worktree for a task. UUID-based path under
 * WORKTREE_ROOT so two tasks for the same Jira key never collide on disk.
 *
 * Errors:
 * - throws AppError("BASE_REPO_NOT_CONFIGURED") if env.BASE_REPO is missing
 * - throws Conflict if the remote branch already has an open PR for a
 *   different task (preflight gate from plan G10)
 */
export async function ensureWorktree(taskId: string, jiraKey: string): Promise<WorktreeInfo> {
  if (!env.BASE_REPO) {
    throw new AppError("BASE_REPO is not set in env");
  }
  if (!existsSync(path.join(env.BASE_REPO, ".git"))) {
    throw new AppError(`BASE_REPO is not a git repository: ${env.BASE_REPO}`);
  }

  const existing = db
    .select()
    .from(worktrees)
    .where(eq(worktrees.taskId, taskId))
    .limit(1)
    .all();
  const existingRow = existing[0];

  if (existingRow && existingRow.status === "live" && existsSync(existingRow.path)) {
    db.update(worktrees)
      .set({ lastUsedAt: new Date() })
      .where(eq(worktrees.path, existingRow.path))
      .run();
    return { path: existingRow.path, branch: existingRow.branch };
  }

  const wtPath = path.join(env.WORKTREE_ROOT, taskId);
  const branch = `${jiraKey}${BRANCH_SUFFIX}`;

  await preflightBranch(jiraKey, branch);

  // Refresh main + ensure the worktree root exists.
  await mkdir(env.WORKTREE_ROOT, { recursive: true });
  await exec("git", ["fetch", "origin", "main"], { cwd: env.BASE_REPO });

  // Clean any stale local branch + worktree pointing at the same path.
  // Failures here are non-fatal — these are best-effort cleanup.
  await exec("git", ["worktree", "remove", "--force", wtPath], { cwd: env.BASE_REPO }).catch(
    () => {},
  );
  await exec("git", ["branch", "-D", branch], { cwd: env.BASE_REPO }).catch(() => {});

  await exec("git", ["worktree", "add", "-B", branch, wtPath, "origin/main"], {
    cwd: env.BASE_REPO,
  });

  // Standard layout — agents write to these paths.
  await mkdir(path.join(wtPath, "docs/brainstorms"), { recursive: true });
  await mkdir(path.join(wtPath, "docs/plans"), { recursive: true });
  await mkdir(path.join(wtPath, "docs/reviews"), { recursive: true });

  const now = new Date();
  db.insert(worktrees)
    .values({
      path: wtPath,
      taskId,
      branch,
      createdAt: now,
      lastUsedAt: now,
      status: "live",
    })
    .onConflictDoUpdate({
      target: worktrees.taskId,
      set: { path: wtPath, branch, status: "live", lastUsedAt: now },
    })
    .run();

  return { path: wtPath, branch };
}

/**
 * Refuse to create a worktree if the branch already exists on origin AND
 * has an open PR — that's an active prior run we don't want to clobber.
 * If the branch exists but no open PR, we delete + recreate (covered by the
 * cleanup above).
 */
async function preflightBranch(jiraKey: string, branch: string): Promise<void> {
  if (!env.BASE_REPO) return;

  const remoteBranchExists = await exec("git", [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    branch,
  ], { cwd: env.BASE_REPO })
    .then(() => true)
    .catch(() => false);

  if (!remoteBranchExists) return;

  // Branch exists remotely. Check for open PR via gh; if missing, treat as
  // recoverable (we'll force-recreate the local branch).
  let prJson: string;
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number"],
      { cwd: env.BASE_REPO },
    );
    prJson = stdout.trim();
  } catch {
    // gh not authed or fails → don't block the worktree creation; surface
    // the issue at Approve & PR time instead.
    return;
  }

  if (!prJson || prJson === "[]") return;

  let parsed: Array<{ url: string; number: number }>;
  try {
    parsed = JSON.parse(prJson);
  } catch {
    return;
  }
  const open = parsed[0];
  if (!open) return;

  throw new Conflict(
    `${jiraKey} already has an open PR (${open.url}). Close it or delete branch ${branch} before retrying.`,
  );
}

/** Mark a worktree row as removed in the DB. Disk cleanup is the daily cron's job. */
export function markWorktreeRemoved(taskId: string): void {
  db.update(worktrees)
    .set({ status: "removed" })
    .where(eq(worktrees.taskId, taskId))
    .run();
}

/**
 * Physically remove a task's worktree from disk and mark the DB row removed.
 * Best-effort: git worktree remove is tried first (clean unregister from the
 * parent repo's .git/worktrees), then rm -rf as a fallback if git's refusal
 * or path drift leaves junk behind. The local branch is deleted too so a
 * future ensureWorktree() can re-create cleanly.
 *
 * Remote state (origin branch, open PRs) is NOT touched — callers surface
 * warnings for those separately.
 */
export async function removeWorktreeForTask(taskId: string): Promise<{
  removed: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const row = db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).limit(1).get();
  if (!row || row.status === "removed") {
    // No live worktree to clean — still return success so the caller can
    // proceed with archival.
    return { removed: false, warnings };
  }
  if (!env.BASE_REPO) {
    warnings.push("BASE_REPO not configured; leaving worktree on disk");
    markWorktreeRemoved(taskId);
    return { removed: false, warnings };
  }

  // 1. Ask git to unregister the worktree cleanly. --force covers dirty
  //    trees (uncommitted edits from the agent).
  try {
    await exec("git", ["worktree", "remove", "--force", row.path], {
      cwd: env.BASE_REPO,
    });
  } catch (err) {
    warnings.push(`git worktree remove failed: ${(err as Error).message}`);
  }

  // 2. Delete the local branch if it still exists (independent of worktree).
  try {
    await exec("git", ["branch", "-D", row.branch], { cwd: env.BASE_REPO });
  } catch {
    // branch may already be gone as part of the worktree remove; fine.
  }

  // 3. rm -rf as belt-and-braces in case step 1 left orphan files (happens
  //    when the worktree root was manually mucked with).
  if (existsSync(row.path)) {
    try {
      await rm(row.path, { recursive: true, force: true });
    } catch (err) {
      warnings.push(`rm -rf failed: ${(err as Error).message}`);
    }
  }

  markWorktreeRemoved(taskId);
  return { removed: true, warnings };
}
