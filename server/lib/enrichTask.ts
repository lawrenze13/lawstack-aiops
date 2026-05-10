import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, prRecords, runs } from "@/server/db/schema";
import { parseTestArtifact } from "@/server/git/testComplete";

// Given a slim task row, enrich it with the current run's status + cost
// and the latest PR-record state. Used by both /(me) and /team boards.

export function enrichTask(t: {
  id: string;
  jiraKey: string;
  title: string;
  currentLane: string;
  ownerId: string;
  currentRunId: string | null;
}) {
  const currentRun = t.currentRunId
    ? db
        .select({
          status: runs.status,
          costUsdMicros: runs.costUsdMicros,
          agentConfigSnapshotJson: runs.agentConfigSnapshotJson,
        })
        .from(runs)
        .where(eq(runs.id, t.currentRunId))
        .limit(1)
        .get()
    : null;

  // Pull runnerType out of the snapshot so the UI can hide the cost
  // field on script runs (always $0; visually ambiguous next to
  // cost-killed Claude runs that also report $0). Snapshot parsing
  // is per-card; with realistic board sizes the JSON.parse cost is
  // negligible. Defaults to "claude" for runs predating the
  // discriminator.
  let runnerType: "claude" | "script" = "claude";
  if (currentRun?.agentConfigSnapshotJson) {
    try {
      const snap = JSON.parse(currentRun.agentConfigSnapshotJson) as {
        runnerType?: "claude" | "script";
      };
      if (snap.runnerType === "script") runnerType = "script";
    } catch {
      // ignore — default stays claude
    }
  }
  const pr = db
    .select({ state: prRecords.state, prUrl: prRecords.prUrl })
    .from(prRecords)
    .where(eq(prRecords.taskId, t.id))
    .limit(1)
    .get();

  // Latest test artifact — drives the lane chip's pass/fail count on
  // the board. One extra point lookup per card; with realistic board
  // sizes (tens of cards per user) this stays well under 100ms total.
  // Skip the query when the card has never reached the test lane to
  // avoid the hit on the common case (cards on plan/review/pr).
  const testArtifact =
    t.currentLane === "test" || t.currentLane === "done"
      ? db
          .select({ markdown: artifacts.markdown })
          .from(artifacts)
          .where(and(eq(artifacts.taskId, t.id), eq(artifacts.kind, "test")))
          .orderBy(desc(artifacts.createdAt))
          .limit(1)
          .get()
      : null;
  const testParsed = testArtifact ? parseTestArtifact(testArtifact.markdown) : null;

  return {
    id: t.id,
    jiraKey: t.jiraKey,
    title: t.title,
    currentLane: t.currentLane as
      | "ticket"
      | "branch"
      | "brainstorm"
      | "plan"
      | "review"
      | "pr"
      | "implement"
      | "test"
      | "done",
    ownerId: t.ownerId,
    runStatus: (currentRun?.status ?? null) as
      | "running"
      | "completed"
      | "failed"
      | "stopped"
      | "cost_killed"
      | "interrupted"
      | "awaiting_input"
      | null,
    costUsd: currentRun ? currentRun.costUsdMicros / 1_000_000 : 0,
    runnerType,
    prState: pr?.state ?? null,
    prUrl: pr?.prUrl ?? null,
    testVerdict: (testParsed?.verdict ?? null) as
      | "PASS"
      | "FAIL"
      | "SKIPPED"
      | null,
    testPassCount: testParsed?.passed ?? 0,
    testFailCount: testParsed?.failed ?? 0,
  };
}
