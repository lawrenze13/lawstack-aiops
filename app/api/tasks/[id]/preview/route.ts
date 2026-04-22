import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import {
  AppError,
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
} from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { prRecords, tasks } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { audit } from "@/server/auth/audit";

export const runtime = "nodejs";

const exec = promisify(execFile);

/**
 * POST /api/tasks/:id/preview
 *
 * Swaps the local dev checkout at `PREVIEW_DEV_PATH` onto this task's
 * feature branch so the user can hit `PREVIEW_DEV_URL` in a new tab and
 * see the PR's code running.
 *
 * Safety:
 *   - Aborts if the dev dir has uncommitted changes (avoid clobbering
 *     in-flight work).
 *   - Fetches + checks out the branch; clears Yii2's runtime cache so
 *     php-fpm picks up the new classes on the next request.
 *   - Owner/admin gated like the other write endpoints.
 */
export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  if (!env.PREVIEW_DEV_PATH || !env.PREVIEW_DEV_URL) {
    throw new AppError(
      "preview dev env not configured — set PREVIEW_DEV_PATH + PREVIEW_DEV_URL",
    );
  }
  if (!existsSync(path.join(env.PREVIEW_DEV_PATH, ".git"))) {
    throw new AppError(
      `PREVIEW_DEV_PATH is not a git repository: ${env.PREVIEW_DEV_PATH}`,
    );
  }

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can switch the preview");
  }

  const pr = db
    .select({ branch: prRecords.branch })
    .from(prRecords)
    .where(eq(prRecords.taskId, taskId))
    .get();
  if (!pr) throw new Conflict("no branch recorded for this task yet");

  const cwd = env.PREVIEW_DEV_PATH;

  // Guard: refuse to blow away uncommitted TRACKED changes. Untracked
  // files (porcelain `??`) and ignored files (`!!`) are left alone —
  // `git checkout` won't overwrite them, and `git stash` without `-u`
  // doesn't move them either, so blocking on them just frustrates the
  // operator.
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
    const dirty = stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0 && !l.startsWith("??") && !l.startsWith("!!"));
    if (dirty.length > 0) {
      throw new Conflict(
        `preview dev has uncommitted tracked changes — resolve in ${env.PREVIEW_DEV_PATH}:\n${dirty
          .slice(0, 10)
          .join("\n")}${dirty.length > 10 ? `\n…and ${dirty.length - 10} more` : ""}`,
      );
    }
  } catch (err) {
    if (err instanceof Conflict) throw err;
    throw new AppError(`git status failed: ${(err as Error).message}`);
  }

  // Fetch (best-effort — continue on failure so offline dev still works if
  // the branch is already locally synced).
  try {
    await exec("git", ["fetch", "origin", pr.branch], { cwd });
  } catch {
    // swallow — checkout may still succeed from local cache
  }

  try {
    await exec("git", ["checkout", pr.branch], { cwd });
  } catch {
    // Branch may not be locally tracked yet — create a tracking branch.
    try {
      await exec(
        "git",
        ["checkout", "-B", pr.branch, `origin/${pr.branch}`],
        { cwd },
      );
    } catch (err) {
      throw new AppError(`git checkout failed: ${(err as Error).message}`);
    }
  }

  // Best-effort Yii2 cache clear. Missing dir is fine; failure shouldn't
  // block the response.
  const cachePath = path.join(cwd, "runtime", "cache");
  try {
    if (existsSync(cachePath)) {
      await exec("rm", ["-rf", cachePath], { cwd });
    }
  } catch {
    // ignore
  }

  audit({
    action: "preview.switched",
    actorUserId: user.id,
    taskId,
    payload: { branch: pr.branch, path: cwd },
  });

  return {
    ok: true,
    branch: pr.branch,
    previewUrl: env.PREVIEW_DEV_URL,
  };
});
