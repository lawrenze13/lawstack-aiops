import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { prRecords, runs } from "@/server/db/schema";

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
        .select({ status: runs.status, costUsdMicros: runs.costUsdMicros })
        .from(runs)
        .where(eq(runs.id, t.currentRunId))
        .limit(1)
        .get()
    : null;
  const pr = db
    .select({ state: prRecords.state, prUrl: prRecords.prUrl })
    .from(prRecords)
    .where(eq(prRecords.taskId, t.id))
    .limit(1)
    .get();
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
    prState: pr?.state ?? null,
    prUrl: pr?.prUrl ?? null,
  };
}
