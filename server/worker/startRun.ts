import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, auditLog, runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { ensureWorktree } from "@/server/git/worktree";
import {
  buildAmendPlanPrompt,
  getAgent,
  snapshotAgent,
  type Lane,
} from "@/server/agents/registry";
import { syncAgentRegistry } from "@/server/agents/sync";
import { AppError, BadRequest, Conflict, NotFound } from "@/server/lib/errors";
import { env } from "@/server/lib/env";
import { transitionIssueToName } from "@/server/jira/client";
import { spawnAgent } from "./spawnAgent";

const exec = promisify(execFile);

export type StartRunParams = {
  taskId: string;
  lane: Lane;
  agentId: string;
  /** Resume an existing Claude session instead of starting fresh. */
  resumeSessionId?: string;
  /** When resuming, override the default prompt with the caller's text. */
  overridePrompt?: string;
  /**
   * Text to display in the log as the user's message. Forwarded to
   * spawnAgent so it renders as a user bubble above Claude's reply.
   * Typically equal to overridePrompt when coming from chat.
   */
  displayUserMessage?: string;
  /** Who initiated the run — for audit rows. */
  initiator: { userId?: string; kind: "user" | "auto_advance" | "system" };
  /** Drop the 10s idempotency window (e.g. for chat messages that must land). */
  bypassIdempotency?: boolean;
  /**
   * When true, build the prompt with `buildAmendPlanPrompt` — a Plan re-run
   * that explicitly addresses findings in the most recent Review.
   * Only meaningful for lane='plan', agentId='ce:plan'.
   */
  amendFromReview?: boolean;
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

  // Freshness context for Plan / Review prompts. Best-effort — git log
  // failures don't block the run.
  const recentCommits = await getRecentCommits(worktree.path);

  // Prior-review count for Review prompt iteration awareness. Counting
  // artifact rows (not runs) gives the number of complete review passes
  // regardless of retries / stops.
  const priorReviewCount = db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, task.id), eq(artifacts.kind, "review")))
    .all().length;

  const promptContext = {
    jiraKey: task.jiraKey,
    title: task.title,
    description: task.descriptionMd,
    priorArtifacts: priorArtifacts.map((a) => ({ kind: a.kind, markdown: a.markdown })),
    recentCommits,
    priorReviewCount,
  };

  const prompt = params.overridePrompt
    ? params.overridePrompt
    : params.amendFromReview
      ? buildAmendPlanPrompt(promptContext)
      : agent.buildPrompt(promptContext);

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
      amendFromReview: params.amendFromReview ?? false,
    },
  });

  // Best-effort: transition the Jira ticket to "In Progress" on the first
  // user-initiated run so stakeholders watching the ticket see movement.
  // Skipped for auto_advance (already transitioned on the first lane) and
  // for resumes. Silent on failure — a missing transition in the workflow
  // isn't a reason to block the run.
  void maybeTransitionJiraOnFirstRun(task.id, task.jiraKey, params.initiator.kind);

  spawnAgent({
    runId,
    taskId: params.taskId,
    prompt,
    sessionId: freshSessionId,
    model: agent.model,
    worktreePath: worktree.path,
    resumeSessionId: params.resumeSessionId,
    displayUserMessage: params.displayUserMessage,
  });

  return { runId, lane: params.lane, agentId: agent.id };
}

async function maybeTransitionJiraOnFirstRun(
  taskId: string,
  jiraKey: string,
  initiator: "user" | "auto_advance" | "system",
): Promise<void> {
  if (initiator !== "user") return;
  if (!env.JIRA_BASE_URL || !env.JIRA_API_TOKEN) return;

  try {
    // Dedupe: if we already transitioned this task once, don't try again.
    const prior = db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.taskId, taskId), eq(auditLog.action, "jira.transitioned")),
      )
      .limit(1)
      .all();
    if (prior.length > 0) return;

    const target = env.JIRA_START_STATUS;
    const match = await transitionIssueToName(jiraKey, target);
    if (match) {
      audit({
        action: "jira.transitioned",
        taskId,
        payload: { to: target, transitionId: match.id, transitionName: match.name },
      });
    } else {
      audit({
        action: "jira.transition_skipped",
        taskId,
        payload: { to: target, reason: "transition not available from current state" },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[jira] transition failed", {
      jiraKey,
      error: (err as Error).message,
    });
    audit({
      action: "jira.transition_failed",
      taskId,
      payload: { error: (err as Error).message },
    });
  }
}

async function getRecentCommits(worktreePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", "-20", "--oneline", "--no-decorate", "origin/main"],
      { cwd: worktreePath },
    );
    const out = stdout.trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
