import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withAuth } from "@/server/lib/route";
import {
  AppError,
  BadRequest,
  Conflict,
  DirtyTreeConflict,
  Forbidden,
  NotFound,
} from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { prRecords, tasks } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { audit } from "@/server/auth/audit";

export const runtime = "nodejs";

const exec = promisify(execFile);

const RequestBody = z.object({ force: z.boolean().optional() }).optional();

/**
 * POST /api/tasks/:id/preview
 *
 * Swaps the local dev checkout at `PREVIEW_DEV_PATH` onto this task's
 * feature branch so the user can hit `PREVIEW_DEV_URL` in a new tab and
 * see the PR's code running.
 *
 * Body: `{ force?: boolean }` (optional).
 *
 * Safety:
 *   - Default path: aborts with `DirtyTreeConflict` (409, dirtyCount in
 *     body) if the dev dir has uncommitted tracked changes.
 *   - `force: true` path: requires same-origin Origin header (CSRF guard
 *     for a destructive action), captures dirty changes via
 *     `git stash create` so they're recoverable via `git reflog` for
 *     ~14 days, then runs `git checkout -f`.
 *   - Audit row records `force`, `dirtyCount`, `dirtyFiles` (full paths,
 *     server-side only — NOT surfaced to client per security review H3
 *     to prevent leaking unreleased feature names across operators
 *     sharing PREVIEW_DEV_PATH), and `backupStashSha` so post-incident
 *     recovery can find the stash.
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

  // Body is optional. Empty body or missing field = force unspecified =
  // safe (non-force) path. Defensive parse so a malformed body doesn't
  // 500 — falls through to non-force.
  const parsed = RequestBody.safeParse(
    await req.json().catch(() => undefined),
  );
  const force = parsed.success && parsed.data?.force === true;

  // CSRF guard for the destructive force-switch path. NextAuth's CSRF
  // protection covers ITS OWN endpoints, not arbitrary /api/* routes —
  // the session cookie alone isn't enough for an action that discards
  // uncommitted work. Same-origin check is the cheapest defense that
  // browsers can't be tricked into bypassing.
  if (force) {
    const originHeader = req.headers.get("origin");
    const expectedUrl = env.AUTH_URL || (() => {
      const host = req.headers.get("host");
      return host ? `https://${host}` : null;
    })();
    if (!originHeader) {
      throw new Forbidden("force-switch requires same-origin request (no Origin header)");
    }
    try {
      const originHost = new URL(originHeader).host;
      const expectedHost = expectedUrl ? new URL(expectedUrl).host : null;
      if (!expectedHost || originHost !== expectedHost) {
        throw new Forbidden("force-switch requires same-origin request");
      }
    } catch (err) {
      if (err instanceof Forbidden) throw err;
      throw new Forbidden("force-switch requires same-origin request (bad Origin header)");
    }
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

  // Inspect tracked-file dirtiness. Untracked (`??`) and ignored (`!!`)
  // files are left alone — `git checkout` won't clobber them, and
  // surfacing them as "dirty" just frustrates the operator.
  let dirtyFiles: string[] = [];
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
    dirtyFiles = stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0 && !l.startsWith("??") && !l.startsWith("!!"));
  } catch (err) {
    throw new AppError(`git status failed: ${(err as Error).message}`);
  }

  if (dirtyFiles.length > 0 && !force) {
    // Default (safe) path — no force flag, dirty tree. Throw a typed
    // conflict that includes the count so the client can render
    // "Discard N changes and switch?" without seeing file PATHS.
    const n = dirtyFiles.length;
    throw new DirtyTreeConflict(
      `preview dev has ${n} uncommitted tracked change${n === 1 ? "" : "s"}. ` +
        `Pass {force:true} to discard.`,
      n,
    );
  }

  // Force-switch path with dirty tree: capture a recoverable backup
  // BEFORE the destructive checkout. `git stash create` produces a
  // dangling commit object without modifying refs/index — the operator
  // can recover via `git reflog` / `fsck` for ~14 days. Best-effort:
  // a stash failure shouldn't block the switch (operator already
  // accepted the destructive intent), but the audit row will show
  // `backupStashSha: null` so post-incident triage knows.
  let backupStashSha: string | null = null;
  if (dirtyFiles.length > 0 && force) {
    try {
      const { stdout } = await exec(
        "git",
        ["stash", "create", "force-switch backup"],
        { cwd },
      );
      backupStashSha = stdout.trim() || null;
    } catch {
      backupStashSha = null;
    }
  }

  // Fetch (best-effort — continue on failure so offline dev still works
  // if the branch is already locally synced).
  try {
    await exec("git", ["fetch", "origin", pr.branch], { cwd });
  } catch {
    // swallow — checkout may still succeed from local cache
  }

  try {
    const checkoutArgs = force
      ? ["checkout", "-f", pr.branch]
      : ["checkout", pr.branch];
    await exec("git", checkoutArgs, { cwd });
  } catch {
    // Branch may not be locally tracked yet — create a tracking branch.
    // Force-create with `-B` so this also handles the "branch exists
    // but in a stuck state" case after a force-switch.
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
    payload: {
      branch: pr.branch,
      path: cwd,
      force,
      dirtyCount: dirtyFiles.length,
      // Full paths recorded server-side ONLY (not in API response) so
      // post-incident recovery can identify what was discarded without
      // leaking unreleased feature names across operators.
      dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
      backupStashSha: backupStashSha ?? undefined,
    },
  });

  return {
    ok: true,
    branch: pr.branch,
    previewUrl: env.PREVIEW_DEV_URL,
  };
});
