import { cp } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, auditLog, prRecords, runs, tasks, worktrees } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { env } from "@/server/lib/env";
import { postComment, transitionIssueToName } from "@/server/jira/client";
import { testCompleteCommentDoc } from "@/server/jira/adf";

type Step =
  | "read_artifact"
  | "report_persistence"
  | "test_comment"
  | "test_pass_transition"
  | "lane_to_done";

export type TestCompleteResult =
  | {
      ok: true;
      verdict: "PASS" | "FAIL" | "SKIPPED";
      passed: number;
      failed: number;
      reportsPath: string | null;
      jiraCommentId: string | null;
      transitioned: boolean;
      warnings: string[];
    }
  | { ok: false; failedAt: Step; error: string };

/**
 * Runs after `test:playwright` exits with status='completed' AND its
 * artifact has been persisted. Reads the verdict + counts from the
 * artifact frontmatter, copies the worktree's `playwright-report/`
 * (and `test-results.json`) to TEST_REPORTS_ROOT so they survive the
 * nightly worktree GC, posts a Jira comment with the outcome, and on
 * PASS moves the lane to `done` (optionally firing
 * JIRA_TEST_PASS_TRANSITION on the way).
 *
 * On FAIL the lane stays on `test` so the operator's Re-run / Fix /
 * Skip buttons render. The Jira comment + persisted report are enough
 * for them to triage; no automatic re-flow at this layer.
 *
 * Audit-log dedupe on every external effect (mirrors implementComplete)
 * so a double-finalise can't double-comment Jira or move the lane
 * twice.
 */
export async function testComplete(
  runId: string,
  taskId: string,
): Promise<TestCompleteResult> {
  const warnings: string[] = [];

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    return { ok: false, failedAt: "read_artifact", error: "task not found" };
  }
  const wt = db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).limit(1).get();
  const pr = db.select().from(prRecords).where(eq(prRecords.taskId, taskId)).limit(1).get();

  // ─── Step 0: read the test artifact ──────────────────────────────────
  // The agent writes verdict + counts into the YAML frontmatter; we
  // parse without a YAML library to avoid adding a dep just for this.
  const artifactRow = db
    .select({ markdown: artifacts.markdown, filename: artifacts.filename })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, "test")))
    .orderBy(desc(artifacts.createdAt))
    .limit(1)
    .get();

  if (!artifactRow) {
    return {
      ok: false,
      failedAt: "read_artifact",
      error: "no test artifact found for this task",
    };
  }
  const parsed = parseTestArtifact(artifactRow.markdown);

  // ─── Step 1: copy reports to TEST_REPORTS_ROOT ───────────────────────
  // Best-effort: a copy failure does not block the lane move or Jira
  // comment. It does emit a warning so the operator knows the persisted
  // copy is missing and the worktree's report is the only surviving
  // copy until cleanup.
  let reportsPath: string | null = null;
  if (
    wt?.path &&
    env.TEST_REPORTS_ROOT &&
    !hasPriorAudit(taskId, "test.reports_persisted", runId)
  ) {
    try {
      reportsPath = path.join(env.TEST_REPORTS_ROOT, task.jiraKey, runId);
      const src = path.join(wt.path, "playwright-report");
      await cp(src, reportsPath, { recursive: true, force: true });
      // Also copy the JSON summary if it exists — small, useful to
      // re-parse without unzipping the HTML report.
      const srcJson = path.join(wt.path, "test-results.json");
      try {
        await cp(srcJson, path.join(reportsPath, "test-results.json"), { force: true });
      } catch {
        // Optional; ignore if missing.
      }
      audit({
        action: "test.reports_persisted",
        taskId,
        runId,
        payload: { dst: reportsPath },
      });
    } catch (err) {
      warnings.push(`copy playwright-report failed: ${(err as Error).message}`);
      audit({
        action: "test.reports_persistence_failed",
        taskId,
        runId,
        payload: { error: (err as Error).message },
      });
      reportsPath = null;
    }
  }

  // ─── Step 2: Jira comment ────────────────────────────────────────────
  let jiraCommentId: string | null = null;
  if (hasPriorAudit(taskId, "jira.test_comment_posted", runId)) {
    warnings.push("test comment already posted; skipping");
  } else if (!env.JIRA_BASE_URL) {
    warnings.push("JIRA_BASE_URL not configured; skipping comment");
  } else if (!pr?.prUrl) {
    warnings.push("no PR url recorded on this task; skipping comment");
  } else {
    try {
      const body = testCompleteCommentDoc({
        jiraKey: task.jiraKey,
        title: task.title,
        prUrl: pr.prUrl,
        branch: pr.branch ?? "(unknown)",
        verdict: parsed.verdict,
        passed: parsed.passed,
        failed: parsed.failed,
        reportsLink: reportsPath ?? undefined,
        failingSpecs: parsed.failingSpecs,
      });
      jiraCommentId = await postComment(task.jiraKey, body);
      audit({
        action: "jira.test_comment_posted",
        taskId,
        runId,
        payload: {
          commentId: jiraCommentId,
          verdict: parsed.verdict,
          passed: parsed.passed,
          failed: parsed.failed,
        },
      });
    } catch (err) {
      // Non-fatal — the artifact + lane state are the source of truth
      // even without a Jira comment.
      warnings.push(`Jira test comment failed: ${(err as Error).message}`);
      audit({
        action: "jira.test_comment_failed",
        taskId,
        runId,
        payload: { error: (err as Error).message },
      });
    }
  }

  // ─── Step 3: Jira PASS transition (optional) ─────────────────────────
  let transitioned = false;
  if (parsed.verdict === "PASS") {
    const targetStatus = env.JIRA_TEST_PASS_TRANSITION;
    if (
      targetStatus &&
      env.JIRA_BASE_URL &&
      env.JIRA_API_TOKEN &&
      !hasPriorAudit(taskId, "jira.test_pass_transitioned", runId)
    ) {
      try {
        const match = await transitionIssueToName(task.jiraKey, targetStatus);
        if (match) {
          transitioned = true;
          audit({
            action: "jira.test_pass_transitioned",
            taskId,
            runId,
            payload: {
              to: targetStatus,
              transitionId: match.id,
              transitionName: match.name,
            },
          });
        } else {
          warnings.push(
            `Jira transition to "${targetStatus}" not available from current state`,
          );
        }
      } catch (err) {
        // Non-fatal: the comment + lane move are the real handoff.
        warnings.push(`Jira test-pass transition failed: ${(err as Error).message}`);
      }
    }
  }

  // ─── Step 4: lane move ───────────────────────────────────────────────
  // PASS  → currentLane: "done", clear currentRunId.
  // FAIL  → lane stays "test", clear currentRunId so the Re-run button
  //         re-enables. UI sources the FAIL banner from the artifact
  //         verdict, not the lane.
  // SKIPPED → currentLane: "done" (Playwright wasn't configured;
  //         carrying the card on `test` indefinitely would be wrong).
  try {
    db.transaction((tx) => {
      const goesToDone = parsed.verdict === "PASS" || parsed.verdict === "SKIPPED";
      tx.update(tasks)
        .set({
          currentLane: goesToDone ? "done" : "test",
          currentRunId: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
        .run();
      tx.insert(auditLog)
        .values({
          action: goesToDone ? "task.test_complete" : "task.test_failed",
          taskId,
          runId,
          payloadJson: JSON.stringify({
            verdict: parsed.verdict,
            passed: parsed.passed,
            failed: parsed.failed,
            reportsPath,
          }),
        })
        .run();
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
    verdict: parsed.verdict,
    passed: parsed.passed,
    failed: parsed.failed,
    reportsPath,
    jiraCommentId,
    transitioned,
    warnings,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

type ParsedTestArtifact = {
  verdict: "PASS" | "FAIL" | "SKIPPED";
  passed: number;
  failed: number;
  failingSpecs: string[];
};

/**
 * Parse the verdict + counts from the test artifact's YAML frontmatter
 * plus a best-effort scrape of failing-spec lines from the body. We
 * don't pull in a YAML library — the frontmatter shape is fixed by the
 * agent's prompt and a regex over the first ~40 lines is enough.
 *
 * Robust to:
 *   - missing or malformed frontmatter (returns FAIL with zeros)
 *   - lowercase/mixed-case verdict values
 *   - extra whitespace around `: `
 */
export function parseTestArtifact(markdown: string): ParsedTestArtifact {
  const lines = markdown.split("\n");
  const fm: Record<string, string> = {};
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && line.trim() === "---") {
      break;
    }
    if (inFrontmatter) {
      const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
      if (m) fm[m[1].toLowerCase()] = m[2].trim();
    }
  }

  const verdictRaw = (fm.verdict ?? "").toUpperCase();
  const verdict: ParsedTestArtifact["verdict"] =
    verdictRaw === "PASS" || verdictRaw === "FAIL" || verdictRaw === "SKIPPED"
      ? (verdictRaw as ParsedTestArtifact["verdict"])
      : "FAIL";

  const passed = parseIntSafe(fm.passed);
  const failed = parseIntSafe(fm.failed);

  // Failing specs: scrape bullet points under any "## Failing" heading.
  const failingSpecs: string[] = [];
  if (verdict === "FAIL") {
    let inFailingSection = false;
    for (const line of lines) {
      if (/^##\s+Failing/i.test(line)) {
        inFailingSection = true;
        continue;
      }
      if (inFailingSection && /^##\s/.test(line)) break;
      if (inFailingSection) {
        const m = line.match(/^[-*]\s+(.+)$/);
        if (m) failingSpecs.push(m[1].trim());
      }
    }
  }

  return { verdict, passed, failed, failingSpecs };
}

function parseIntSafe(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function hasPriorAudit(taskId: string, action: string, runId: string): boolean {
  // Scope to the same runId — a prior testComplete invocation for the
  // SAME run has already done the side-effect; a different run is a
  // separate test attempt and gets to comment again.
  const row = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, action),
        eq(auditLog.runId, runId),
      ),
    )
    .limit(1)
    .get();
  return !!row;
}
