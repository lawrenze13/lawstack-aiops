// Multi-cycle approve — companion to `approveAndPr`, called when the
// task is on cycle N>1 (operator re-ran brainstorm after the first
// done). The shape is parallel to `approveAndPr` minus the per-step
// `prRecords.state` resumability:
//
//   - `approveAndPr` (cycle 1): writes artifacts → opens new PR →
//     posts the "PR opened" Jira comment, with each step gated on
//     `prRecords.state` so the route can be re-invoked after a step
//     failure to resume from where it left off.
//
//   - `approveCycle` (cycle N>1): rewrites artifacts to the SAME
//     branch → reuses the existing PR (no `gh pr create`) → posts
//     no Jira comment (deferred to `implementComplete` for the
//     cycle-N completion message). No state-machine because every
//     step is naturally idempotent (file writes overwrite, commits
//     no-op when nothing's changed, push is robust, no PR creation).
//
// Why a parallel function (not a flag on approveAndPr): see the
// "Alternative F" section in the bug-cluster plan and the architecture-
// strategist deepen-plan finding. tl;dr — `approveAndPr`'s
// state-machine is the *reason* it works for cycle 1's resumable
// semantics; weaving a `force-refresh` flag through it would dilute
// that property and make the function harder to reason about.
//
// The shared substrate (latestArtifactPerKind, kindDir, ghEnv) is
// imported from `./approve` so future tweaks to artifact persistence
// are made in one place.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditLog, prRecords, tasks, worktrees } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { audit } from "@/server/auth/audit";
import { robustPush } from "@/server/git/push";
import {
  AppError,
  BadRequest,
  Conflict,
  NotFound,
} from "@/server/lib/errors";
import { ghEnv, kindDir, latestArtifactPerKind } from "./approve";
import { currentCycleNumber } from "@/server/lib/taskCycle";

const exec = promisify(execFile);

const REQUIRED_KINDS = ["brainstorm", "plan"] as const;
const OPTIONAL_KINDS = ["review"] as const;

type CycleApproveResult = {
  prUrl: string;
  commitSha: string;
  cycleNumber: number;
  /** True when this invocation actually pushed a new commit. False when
   *  it was a no-op (no artifact changes since the last cycle-N approve
   *  attempt — second click landed on a clean tree). */
  pushed: boolean;
};

/**
 * Approve cycle N>1's artifacts and push them to the existing PR.
 *
 * Throws (rather than returning a discriminated `{ok: false}`) on hard
 * failures — the route's error wrapper maps to the right HTTP status.
 * No `prRecords.state` machine: every step is idempotent on its own,
 * and a partial-failure retry is safe (clean tree → no new commit;
 * push of identical refs → "Everything up-to-date").
 *
 * Dedup guard: before any side-effecting work, checks the audit log
 * for an existing `approve.completed` row at this cycleNumber. If
 * found, returns the prior result without re-running. (Deepen-plan
 * must-ship: prevents duplicate side effects from operator double-
 * click + lock-window race.)
 */
export async function approveCycle(
  taskId: string,
  actorUserId: string,
): Promise<CycleApproveResult> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (task.status === "archived") throw new Conflict("task is archived");

  const wt = db
    .select()
    .from(worktrees)
    .where(eq(worktrees.taskId, taskId))
    .limit(1)
    .get();
  if (!wt || wt.status !== "live") {
    throw new BadRequest("no live worktree for this task");
  }
  if (!env.BASE_REPO) throw new AppError("BASE_REPO is not configured");

  // Cycle 1 must use approveAndPr — guard against a misrouted call.
  const cycleNumber = currentCycleNumber(taskId);
  if (cycleNumber < 2) {
    throw new BadRequest(
      `approveCycle requires cycle ≥ 2 (task is on cycle ${cycleNumber}); use approveAndPr`,
    );
  }

  // Dedup guard — see header comment.
  const alreadyCompleted = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, "approve.completed"),
        sql`json_extract(${auditLog.payloadJson}, '$.cycleNumber') = ${cycleNumber}`,
      ),
    )
    .limit(1)
    .all();
  if (alreadyCompleted.length > 0) {
    // Reload prior result from pr_records.
    const prior = db
      .select({ prUrl: prRecords.prUrl, commitSha: prRecords.commitSha })
      .from(prRecords)
      .where(eq(prRecords.taskId, taskId))
      .limit(1)
      .get();
    if (prior?.prUrl && prior.commitSha) {
      return {
        prUrl: prior.prUrl,
        commitSha: prior.commitSha,
        cycleNumber,
        pushed: false,
      };
    }
    // Fall through if the prior record is somehow missing — better to
    // re-run than fail.
  }

  // Validate latest artifacts present + non-stale before any worktree work.
  const latestArtifacts = latestArtifactPerKind(taskId);
  for (const kind of REQUIRED_KINDS) {
    const a = latestArtifacts.get(kind);
    if (!a) throw new BadRequest(`missing required ${kind} artifact`);
    if (a.isStale) {
      throw new BadRequest(
        `${kind} artifact is stale; re-run ${kind} before approving cycle ${cycleNumber}`,
      );
    }
  }

  // Find the existing PR via gh — fail fast if missing (cycle N>1 with
  // no PR is a corrupt state; operator should investigate via
  // approveAndPr first).
  let prUrl: string;
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "list", "--head", wt.branch, "--state", "open", "--json", "url,number"],
      { cwd: wt.path, env: ghEnv() },
    );
    const list = JSON.parse(stdout || "[]") as Array<{ url: string }>;
    if (list.length === 0) {
      throw new BadRequest(
        `no open PR for branch ${wt.branch}; cycle 2+ approve requires the cycle 1 PR`,
      );
    }
    prUrl = list[0]!.url;
  } catch (err) {
    if (err instanceof BadRequest) throw err;
    throw new AppError(`gh pr list failed: ${(err as Error).message}`);
  }

  // ─── Step 1: write the latest artifact markdown into the worktree ─
  // Overwrites cycle-1's files; on-disk state always matches latest DB.
  for (const kind of [...REQUIRED_KINDS, ...OPTIONAL_KINDS]) {
    const a = latestArtifacts.get(kind);
    if (!a) continue;
    const dir = kindDir(kind);
    const fullPath = path.join(wt.path, dir, a.filename);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, a.markdown, "utf8");
  }

  // ─── Step 2: git add + commit ────────────────────────────────────
  let commitSha: string | undefined;
  let pushed = false;
  try {
    await exec(
      "git",
      ["add", "docs/brainstorms", "docs/plans", "docs/reviews"],
      { cwd: wt.path },
    ).catch(() => {});
    for (const kind of [...REQUIRED_KINDS, ...OPTIONAL_KINDS]) {
      const a = latestArtifacts.get(kind);
      if (!a) continue;
      await exec("git", ["add", path.join(kindDir(kind), a.filename)], {
        cwd: wt.path,
      }).catch(() => {});
    }

    const { stdout: statusOut } = await exec(
      "git",
      ["status", "--porcelain"],
      { cwd: wt.path },
    );
    if (!statusOut.trim()) {
      // Nothing changed since the prior cycle-N commit — reuse HEAD.
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: wt.path });
      commitSha = stdout.trim();
    } else {
      const msg =
        `docs(${task.jiraKey}): cycle ${cycleNumber} brainstorm + plan` +
        `\n\n${task.title}`;
      await exec(
        "git",
        [
          "-c",
          "user.email=ai-ops@multiportal.io",
          "-c",
          "user.name=lawstack-aiops",
          "commit",
          "-m",
          msg,
        ],
        { cwd: wt.path },
      );
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: wt.path });
      commitSha = stdout.trim();
      pushed = true;
    }
  } catch (err) {
    throw new AppError(`commit failed: ${(err as Error).message}`);
  }

  // ─── Step 3: push (idempotent — robustPush handles fast-forward + rebase) ─
  try {
    await robustPush(wt.path, wt.branch);
  } catch (err) {
    throw new AppError(`push failed: ${(err as Error).message}`);
  }

  // ─── Step 4: update pr_records.commitSha (lane stays where caller wants) ──
  // Don't touch `state` — that's the cycle-1 state-machine's column.
  const now = new Date();
  db.update(prRecords)
    .set({ commitSha, updatedAt: now })
    .where(eq(prRecords.taskId, taskId))
    .run();

  // ─── Step 5: lane → pr ───────────────────────────────────────────
  db.update(tasks)
    .set({ currentLane: "pr", updatedAt: now })
    .where(eq(tasks.id, taskId))
    .run();

  // ─── Step 6: audit (part of dedup contract — payload.cycleNumber) ─
  audit({
    action: "approve.completed",
    actorUserId,
    taskId,
    payload: {
      prUrl,
      commitSha,
      cycleNumber,
      cycleApprove: true,
      pushed,
    },
  });

  return { prUrl, commitSha: commitSha!, cycleNumber, pushed };
}
