import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type RobustPushResult = {
  ok: true;
  rebased: boolean;
  setUpstream: boolean;
};

export class PushFailedError extends Error {
  constructor(
    message: string,
    public readonly stage: "push" | "fetch" | "rebase",
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PushFailedError";
  }
}

/**
 * Push `branch` from `cwd` with auto-recovery for the common failure modes
 * we hit on AI-owned branches:
 *
 *   1. Upstream missing      → `git push -u origin <branch>`.
 *   2. Non-fast-forward      → someone else advanced the remote (an earlier
 *                              Approve run, an implementation commit from
 *                              a concurrent worktree, etc). Fetch + rebase
 *                              the remote into the local branch, then push.
 *
 * Any other error surfaces as a `PushFailedError` with the stage so the
 * caller can decide how to report it to the user.
 */
export async function robustPush(
  cwd: string,
  branch: string,
): Promise<RobustPushResult> {
  // Attempt 1: plain push. Works when upstream is set and local is ahead.
  try {
    await exec("git", ["push"], { cwd });
    return { ok: true, rebased: false, setUpstream: false };
  } catch (err1) {
    const msg1 = asErrMessage(err1);

    // Non-FF: remote is ahead. Fetch + rebase + retry.
    if (isNonFastForward(msg1)) {
      return await rebaseAndPush(cwd, branch);
    }

    // Upstream missing: `git push` errors with "has no upstream branch".
    // Retry with -u to set it, which ALSO can fail non-FF if the remote
    // branch already has commits the local doesn't.
    try {
      await exec("git", ["push", "-u", "origin", branch], { cwd });
      return { ok: true, rebased: false, setUpstream: true };
    } catch (err2) {
      const msg2 = asErrMessage(err2);
      if (isNonFastForward(msg2)) {
        return await rebaseAndPush(cwd, branch);
      }
      throw new PushFailedError(msg2 || msg1, "push", err2);
    }
  }
}

async function rebaseAndPush(
  cwd: string,
  branch: string,
): Promise<RobustPushResult> {
  try {
    await exec("git", ["fetch", "origin", branch], { cwd });
  } catch (err) {
    throw new PushFailedError(
      `git fetch origin ${branch} failed: ${asErrMessage(err)}`,
      "fetch",
      err,
    );
  }
  try {
    // Rebase local commits on top of the fetched remote. If the agent
    // touched different files, this is a clean fast-forward through the
    // remote's new tip. If there's a true conflict, rebase aborts with a
    // non-zero exit; we surface it and let the human resolve.
    await exec(
      "git",
      [
        "-c",
        "user.email=ai-ops@multiportal.io",
        "-c",
        "user.name=lawstack-aiops",
        "rebase",
        `origin/${branch}`,
      ],
      { cwd },
    );
  } catch (err) {
    // Leave the rebase state visible in the worktree for inspection; don't
    // auto-abort, because a half-finished rebase is a signal the worktree
    // is in a manual-fix state.
    throw new PushFailedError(
      `rebase onto origin/${branch} failed (resolve manually in the worktree): ${asErrMessage(err)}`,
      "rebase",
      err,
    );
  }
  try {
    await exec("git", ["push", "-u", "origin", branch], { cwd });
    return { ok: true, rebased: true, setUpstream: true };
  } catch (err) {
    throw new PushFailedError(
      `push after rebase failed: ${asErrMessage(err)}`,
      "push",
      err,
    );
  }
}

function isNonFastForward(s: string): boolean {
  return /non-fast-forward|rejected.*fetch first|tip of your current branch is behind/i.test(
    s,
  );
}

function asErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
