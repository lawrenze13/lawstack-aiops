import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { worktrees } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { Conflict, AppError } from "@/server/lib/errors";

const exec = promisify(execFile);

const BRANCH_PREFIX = "ai/";

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
  const branch = `${BRANCH_PREFIX}${jiraKey}`;

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
