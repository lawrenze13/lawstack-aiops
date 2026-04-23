import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, runs, tasks, worktrees } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { AGENTS } from "@/server/agents/registry";

// Every possible `artifacts.kind` value. Core 4 are gated by Approve & PR;
// the specialist kinds (research, *-review, deploy-check) are visible in
// the ArtifactPanel but never block the PR flow or create staleness.
type ArtifactKind =
  | "brainstorm"
  | "plan"
  | "review"
  | "implementation"
  | "research"
  | "security-review"
  | "perf-review"
  | "deploy-check";

// Per-lane default artifact path + kind. Used when the agent config doesn't
// declare its own `produces` (i.e., the core ce:* agents).
const LANE_TO_KIND: Record<string, { kind: ArtifactKind; dir: string }> = {
  brainstorm: { kind: "brainstorm", dir: "docs/brainstorms" },
  plan: { kind: "plan", dir: "docs/plans" },
  review: { kind: "review", dir: "docs/reviews" },
  implement: { kind: "implementation", dir: "docs/implementation" },
};

// Downstream order: re-running X makes these stale. Only the 4 core kinds
// participate in staleness; specialist artifacts are side-notes.
const DOWNSTREAM: Record<string, ArtifactKind[]> = {
  brainstorm: ["plan", "review"],
  plan: ["review"],
  review: [],
  implementation: [],
  research: [],
  "security-review": [],
  "perf-review": [],
  "deploy-check": [],
};

/**
 * Called from spawnAgent.finalize() when a run completes. Reads the expected
 * artifact file out of the worktree, creates/updates the artifacts row for
 * (task, kind), supersedes prior artifacts of the same kind, and marks
 * downstream kinds as `is_stale` so the Approve gate blocks until they're
 * regenerated.
 *
 * Best-effort — any failure logs + writes an audit row but does not throw.
 */
export async function persistArtifactsForRun(runId: string): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return;

  // Prefer the agent's declared output; fall back to the lane default.
  // Specialist agents (security:review, ce:research, …) set `produces`;
  // the core ce:* agents rely on the lane-based default.
  const agent = (AGENTS as Record<string, { produces?: { kind: string; dir: string } }>)[run.agentId];
  const laneMap =
    (agent?.produces
      ? { kind: agent.produces.kind as ArtifactKind, dir: agent.produces.dir }
      : undefined) ?? LANE_TO_KIND[run.lane];
  if (!laneMap) return; // 'pr' lane or unknown — no artifact expected

  const wt = db.select().from(worktrees).where(eq(worktrees.taskId, run.taskId)).limit(1).get();
  if (!wt) return;

  const taskRow = db
    .select({ jiraKey: tasks.jiraKey })
    .from(tasks)
    .where(eq(tasks.id, run.taskId))
    .limit(1)
    .get();
  const jiraKey = taskRow?.jiraKey;
  if (!jiraKey) {
    // eslint-disable-next-line no-console
    console.warn("[persistArtifacts] no jira_key for task", { taskId: run.taskId });
    return;
  }

  const filename = `${jiraKey}-${laneMap.kind}.md`;
  const fullPath = path.join(wt.path, laneMap.dir, filename);

  if (!existsSync(fullPath)) {
    // Some agents might write under different filename conventions. Do a
    // shallow scan of the kind's dir as a fallback.
    const { readdir } = await import("node:fs/promises");
    try {
      const files = await readdir(path.join(wt.path, laneMap.dir));
      const firstMd = files.find((f) => f.endsWith(".md"));
      if (!firstMd) {
        audit({
          action: "artifact.missing",
          runId,
          taskId: run.taskId,
          payload: { kind: laneMap.kind, expected: filename },
        });
        return;
      }
      await upsertArtifact({
        runId,
        taskId: run.taskId,
        kind: laneMap.kind,
        filename: firstMd,
        fullPath: path.join(wt.path, laneMap.dir, firstMd),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[persistArtifacts] scan failed", { err });
    }
    return;
  }

  await upsertArtifact({
    runId,
    taskId: run.taskId,
    kind: laneMap.kind,
    filename,
    fullPath,
  });
}

async function upsertArtifact(opts: {
  runId: string;
  taskId: string;
  kind: ArtifactKind;
  filename: string;
  fullPath: string;
}): Promise<void> {
  let markdown: string;
  try {
    markdown = await readFile(opts.fullPath, "utf8");
  } catch (err) {
    audit({
      action: "artifact.read_failed",
      runId: opts.runId,
      taskId: opts.taskId,
      payload: { kind: opts.kind, error: (err as Error).message },
    });
    return;
  }

  const now = new Date();

  db.transaction((tx) => {
    // Find the most recent prior non-stale artifact of the same kind for
    // this task; link as `supersedesId`.
    const prior = tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.taskId, opts.taskId), eq(artifacts.kind, opts.kind)))
      .orderBy(desc(artifacts.createdAt))
      .limit(1)
      .all();

    tx.insert(artifacts)
      .values({
        id: randomUUID(),
        runId: opts.runId,
        taskId: opts.taskId,
        kind: opts.kind,
        filename: opts.filename,
        markdown,
        isApproved: false,
        isStale: false,
        supersedesId: prior[0]?.id ?? null,
        createdAt: now,
      })
      .run();

    // Mark downstream kinds as stale so the Approve gate catches the fact
    // that upstream changed without re-running them.
    for (const downstreamKind of DOWNSTREAM[opts.kind] ?? []) {
      tx.update(artifacts)
        .set({ isStale: true })
        .where(and(eq(artifacts.taskId, opts.taskId), eq(artifacts.kind, downstreamKind)))
        .run();
    }
  });

  audit({
    action: "artifact.persisted",
    runId: opts.runId,
    taskId: opts.taskId,
    payload: { kind: opts.kind, filename: opts.filename, size: markdown.length },
  });
}
