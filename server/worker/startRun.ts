import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { ensureWorktree } from "@/server/git/worktree";
import { getAgent, snapshotAgent, type Lane } from "@/server/agents/registry";
import { syncAgentRegistry } from "@/server/agents/sync";
import { AppError, BadRequest, Conflict, NotFound } from "@/server/lib/errors";
import { spawnAgent } from "./spawnAgent";

export type StartRunParams = {
  taskId: string;
  lane: Lane;
  agentId: string;
  /** Resume an existing Claude session instead of starting fresh. */
  resumeSessionId?: string;
  /** When resuming, override the default prompt with the caller's text. */
  overridePrompt?: string;
  /** Who initiated the run — for audit rows. */
  initiator: { userId?: string; kind: "user" | "auto_advance" | "system" };
  /** Drop the 10s idempotency window (e.g. for chat messages that must land). */
  bypassIdempotency?: boolean;
};

export type StartRunResult = {
  runId: string;
  lane: Lane;
  agentId: string;
};

const IDEMPOTENCY_WINDOW_MS = 10_000;

/**
 * Spawn a new run. Used by three call sites with slightly different auth
 * wrappers:
 *   - POST /api/tasks/:id/runs         (user clicks Run X)
 *   - POST /api/runs/:id/message       (user sends chat)
 *   - auto-advance in spawnAgent.finalize()
 *
 * The caller is responsible for authorization checks.
 */
export async function startRun(params: StartRunParams): Promise<StartRunResult> {
  syncAgentRegistry();

  if (params.lane === ("pr" as Lane)) {
    throw new BadRequest("PR lane is not agent-driven; use Approve & PR");
  }

  const task = db.select().from(tasks).where(eq(tasks.id, params.taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (task.status === "archived") throw new Conflict("task is archived");

  const agent = getAgent(params.agentId);
  if (!agent) throw new BadRequest(`unknown agent: ${params.agentId}`);
  if (!agent.lanes.includes(params.lane)) {
    throw new BadRequest(`agent ${agent.id} does not support lane ${params.lane}`);
  }

  if (!params.bypassIdempotency) {
    const recentDup = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, params.taskId),
          eq(runs.lane, params.lane),
          gt(runs.startedAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS)),
          isNull(runs.supersededAt),
        ),
      )
      .limit(1)
      .all();
    if (recentDup.length > 0) {
      throw new Conflict(`a run for ${params.lane} was started within the last 10s`);
    }
  }

  let worktree;
  try {
    worktree = await ensureWorktree(task.id, task.jiraKey);
  } catch (err) {
    if (err instanceof Conflict) throw err;
    throw new AppError(`failed to provision worktree: ${(err as Error).message}`);
  }

  const priorArtifacts = db
    .select({
      kind: artifacts.kind,
      markdown: artifacts.markdown,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(eq(artifacts.taskId, task.id))
    .orderBy(desc(artifacts.createdAt))
    .all();

  const prompt = params.overridePrompt
    ? params.overridePrompt
    : agent.buildPrompt({
        jiraKey: task.jiraKey,
        title: task.title,
        description: task.descriptionMd,
        priorArtifacts: priorArtifacts.map((a) => ({ kind: a.kind, markdown: a.markdown })),
      });

  const runId = randomUUID();
  const freshSessionId = randomUUID();
  const now = new Date();

  // Mark any prior live run for this lane as superseded.
  db.update(runs)
    .set({ supersededAt: now })
    .where(
      and(eq(runs.taskId, params.taskId), eq(runs.lane, params.lane), isNull(runs.supersededAt)),
    )
    .run();

  // If resuming, record linkage to the parent run.
  let resumedFromRunId: string | null = null;
  if (params.resumeSessionId) {
    const parent = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.taskId, params.taskId), eq(runs.claudeSessionId, params.resumeSessionId)),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .all();
    resumedFromRunId = parent[0]?.id ?? null;
  }

  db.insert(runs)
    .values({
      id: runId,
      taskId: params.taskId,
      lane: params.lane,
      agentId: agent.id,
      agentConfigSnapshotJson: snapshotAgent(agent),
      claudeSessionId: params.resumeSessionId ?? freshSessionId,
      status: "running",
      startedAt: now,
      lastHeartbeatAt: now,
      resumedFromRunId,
    })
    .run();

  db.update(tasks)
    .set({ currentLane: params.lane, currentRunId: runId, updatedAt: now })
    .where(eq(tasks.id, params.taskId))
    .run();

  audit({
    action: "run.started_request",
    actorUserId: params.initiator.userId ?? null,
    taskId: params.taskId,
    runId,
    payload: {
      lane: params.lane,
      agentId: agent.id,
      resume: !!params.resumeSessionId,
      initiator: params.initiator.kind,
    },
  });

  spawnAgent({
    runId,
    taskId: params.taskId,
    prompt,
    sessionId: freshSessionId,
    model: agent.model,
    worktreePath: worktree.path,
    resumeSessionId: params.resumeSessionId,
  });

  return { runId, lane: params.lane, agentId: agent.id };
}
