import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditLog, prRecords, worktrees } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { audit } from "@/server/auth/audit";

const exec = promisify(execFile);

export type ReviewVerdict = "PASS" | "P1" | "P2_BLOCKER";

export type ReviewState =
  | { kind: "none" }
  | { kind: "pending"; since: number }
  | { kind: "verdict"; verdict: ReviewVerdict; blockers: string | null; at: number };

/**
 * Derive the current CI-review state for a task from the audit_log.
 *
 * Events we look at:
 *   - `review.pending`     — written when the orchestrator undrafts the PR,
 *                            hands off to the CI workflow.
 *   - `review.verdict`     — written once this module has scraped the PR
 *                            comments and found a REVIEW_RESULT line.
 *
 * Whichever is newer wins. Returns `{kind:"none"}` if neither has ever fired
 * for this task (e.g., ticket never reached implement-approve).
 */
export function readReviewState(taskId: string): ReviewState {
  const row = db
    .select({
      action: auditLog.action,
      payload: auditLog.payloadJson,
      ts: auditLog.ts,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        // Any review-scoped action. We filter in JS rather than with IN() so
        // we don't repeat the enum values in two places.
      ),
    )
    .orderBy(desc(auditLog.ts))
    .all();
  const latest = row.find(
    (r) => r.action === "review.pending" || r.action === "review.verdict",
  );
  if (!latest) return { kind: "none" };
  // audit_log.ts is a Date column in drizzle (mode: 'timestamp_ms');
  // convert to plain ms for the API shape the client expects.
  const tsMs = latest.ts instanceof Date ? latest.ts.getTime() : Number(latest.ts);
  if (latest.action === "review.pending") {
    return { kind: "pending", since: tsMs };
  }
  // review.verdict
  try {
    const p = JSON.parse(latest.payload ?? "{}") as {
      verdict?: string;
      blockers?: string | null;
    };
    if (p.verdict === "PASS" || p.verdict === "P1" || p.verdict === "P2_BLOCKER") {
      return {
        kind: "verdict",
        verdict: p.verdict,
        blockers: p.blockers ?? null,
        at: tsMs,
      };
    }
  } catch {
    // fallthrough
  }
  return { kind: "none" };
}

/**
 * Fetch the PR comments for the task's branch via `gh pr view`, scan them
 * for a `REVIEW_RESULT:` line, and (if found) write a `review.verdict`
 * audit row. Idempotent — calling twice after the verdict landed just
 * skips the write.
 *
 * Returns the latest ReviewState post-check, so the caller can surface
 * it to the UI without a second round-trip.
 */
export async function checkReviewVerdict(taskId: string): Promise<ReviewState> {
  // Skip if we already have a verdict cached.
  const prior = readReviewState(taskId);
  if (prior.kind === "verdict") return prior;
  // Skip if we never signalled pending (nothing to check).
  if (prior.kind === "none") return prior;

  const pr = db
    .select({ branch: prRecords.branch, prUrl: prRecords.prUrl })
    .from(prRecords)
    .where(eq(prRecords.taskId, taskId))
    .get();
  if (!pr) return prior;

  // cwd for gh: prefer the task's worktree, fall back to BASE_REPO.
  const wt = db
    .select({ path: worktrees.path, status: worktrees.status })
    .from(worktrees)
    .where(eq(worktrees.taskId, taskId))
    .get();
  const cwd =
    wt && wt.status !== "removed" && existsSync(wt.path)
      ? wt.path
      : env.BASE_REPO;
  if (!cwd) return prior;

  let commentsJson: string;
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "view", pr.branch, "--json", "comments", "--jq", ".comments"],
      { cwd },
    );
    commentsJson = stdout;
  } catch {
    // gh call failed — leave state as pending, caller can retry.
    return prior;
  }

  let comments: Array<{ body?: string }>;
  try {
    comments = JSON.parse(commentsJson) as Array<{ body?: string }>;
  } catch {
    return prior;
  }

  // Concatenate all comment bodies and match the LAST REVIEW_RESULT line.
  // Matches the same pattern the CI workflow uses.
  const allBodies = comments.map((c) => c.body ?? "").join("\n\n");
  const verdictMatch = allBodies.match(/REVIEW_RESULT:\s*(P1|P2_BLOCKER|PASS)/g);
  if (!verdictMatch || verdictMatch.length === 0) return prior;
  const lastVerdict = verdictMatch[verdictMatch.length - 1]!;
  const verdict = lastVerdict
    .replace(/REVIEW_RESULT:\s*/, "")
    .trim() as ReviewVerdict;

  // Blockers block is optional and only present for P1/P2_BLOCKER.
  let blockers: string | null = null;
  const blockersMatch = allBodies.match(
    /REVIEW_BLOCKERS_START([\s\S]*?)REVIEW_BLOCKERS_END/,
  );
  if (blockersMatch && blockersMatch[1]) {
    blockers = blockersMatch[1].trim();
  }

  audit({
    action: "review.verdict",
    taskId,
    payload: { verdict, blockers, prUrl: pr.prUrl },
  });

  return {
    kind: "verdict",
    verdict,
    blockers,
    at: Date.now(),
  };
}
