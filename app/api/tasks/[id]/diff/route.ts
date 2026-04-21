import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { AppError, BadRequest, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks, worktrees } from "@/server/db/schema";

export const runtime = "nodejs";

const exec = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB cap; larger gets truncated

export const GET = withAuth(async ({ req }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/diff — id is two before 'diff'
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");

  const wt = db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).limit(1).get();
  if (!wt || wt.status !== "live") {
    return {
      hasWorktree: false,
      diff: "",
      stat: "",
      commits: [],
      branch: null as string | null,
    };
  }

  // Gather three things for the viewer:
  //   1. commits on the feature branch since main (short oneline)
  //   2. shortstat (files changed, insertions, deletions) — header chip
  //   3. full unified diff — the meat
  // Fail gracefully on any — a worktree with no commits yet returns empty.
  let commits: Array<{ sha: string; subject: string }> = [];
  try {
    const { stdout } = await exec(
      "git",
      ["log", "origin/main..HEAD", "--pretty=%h%x09%s"],
      { cwd: wt.path, maxBuffer: 512 * 1024 },
    );
    commits = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha: sha ?? "", subject: rest.join("\t") };
      });
  } catch (err) {
    // Branch might not have diverged yet — not fatal
    commits = [];
  }

  let stat = "";
  try {
    const { stdout } = await exec("git", ["diff", "origin/main...HEAD", "--shortstat"], {
      cwd: wt.path,
      maxBuffer: 64 * 1024,
    });
    stat = stdout.trim();
  } catch {
    stat = "";
  }

  let diff = "";
  let truncated = false;
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "origin/main...HEAD", "--no-color", "--no-ext-diff"],
      { cwd: wt.path, maxBuffer: MAX_DIFF_BYTES },
    );
    diff = stdout;
    // execFile's maxBuffer kills with ENOBUFS if exceeded; catch below. If we
    // got here, diff ≤ MAX_DIFF_BYTES. No truncation.
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("maxBuffer")) {
      // Re-try with a head-only partial so the user can still see something.
      try {
        const { stdout } = await exec(
          "sh",
          [
            "-c",
            `git diff origin/main...HEAD --no-color --no-ext-diff | head -c ${MAX_DIFF_BYTES}`,
          ],
          { cwd: wt.path, maxBuffer: MAX_DIFF_BYTES + 4096 },
        );
        diff = stdout;
        truncated = true;
      } catch (err2) {
        throw new AppError(`git diff failed: ${(err2 as Error).message}`);
      }
    } else {
      throw new AppError(`git diff failed: ${msg}`);
    }
  }

  return {
    hasWorktree: true,
    branch: wt.branch,
    commits,
    stat,
    diff,
    truncated,
  };
});
