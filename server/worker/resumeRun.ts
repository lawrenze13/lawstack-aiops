import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { ensureWorktree } from "@/server/git/worktree";
import { getAgent } from "@/server/agents/registry";
import { AppError, BadRequest, Conflict, NotFound } from "@/server/lib/errors";
import { runRegistry } from "./runRegistry";
import { spawnAgent } from "./spawnAgent";

export type ResumeRunParams = {
  /** The existing run row to resume — chat turns stack on this same row. */
  runId: string;
  /** The user's new message — becomes the next turn's prompt. */
  prompt: string;
  /** Also surfaced as a user bubble in the run log. Usually equals prompt. */
  displayUserMessage?: string;
  initiator: { userId?: string; kind: "user" | "system" };
};

/**
 * Re-spawn a Claude subprocess bound to an EXISTING run row, using
 * `--resume <claudeSessionId>` to continue the same conversation.
 *
 * Contrast with startRun() which always creates a new run row. Chat
 * messages go through here so a single implement session maps to a
 * single `runs` row — events, cost, and status accumulate on one
 * lifecycle instead of fragmenting into one row per turn.
 */
export async function resumeRun(
  params: ResumeRunParams,
): Promise<{ runId: string }> {
  const run = db.select().from(runs).where(eq(runs.id, params.runId)).get();
  if (!run) throw new NotFound("run not found");
  if (!run.claudeSessionId) {
    throw new BadRequest("no Claude session captured for this run — cannot resume");
  }
  if (run.status === "running") {
    throw new Conflict("run is already running; cannot resume concurrently");
  }

  // Drain any still-alive subprocess for this run. This happens when the
  // user replies within the 10s NEEDS_INPUT grace window — the old child
  // is mid-shutdown but hasn't exited yet. Spawning on top would leave
  // two subprocesses writing to the same run_id, and the old one's
  // finalize() would clobber the new one's status.
  const existing = runRegistry.get(params.runId);
  if (existing) {
    existing.stop("user");
    await waitForExit(params.runId, 15_000);
  }

  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (task.status === "archived") throw new Conflict("task is archived");

  const agent = getAgent(run.agentId);
  if (!agent) throw new BadRequest(`unknown agent: ${run.agentId}`);

  const worktree = await ensureWorktree(task.id, task.jiraKey);

  // Flip back to running on the SAME row. Preserve startedAt and the
  // accumulated costUsdMicros — the meter will continue from there.
  const now = new Date();
  db.update(runs)
    .set({
      status: "running",
      finishedAt: null,
      killedReason: null,
      lastHeartbeatAt: now,
    })
    .where(eq(runs.id, params.runId))
    .run();

  db.update(tasks)
    .set({ currentRunId: params.runId, updatedAt: now })
    .where(eq(tasks.id, task.id))
    .run();

  audit({
    action: "run.resumed",
    actorUserId: params.initiator.userId ?? null,
    taskId: task.id,
    runId: params.runId,
    payload: { initiator: params.initiator.kind },
  });

  const carriedCostUsd = (run.costUsdMicros ?? 0) / 1_000_000;

  spawnAgent({
    runId: params.runId,
    taskId: task.id,
    prompt: params.prompt,
    sessionId: run.claudeSessionId,
    model: agent.model,
    worktreePath: worktree.path,
    resumeSessionId: run.claudeSessionId,
    displayUserMessage: params.displayUserMessage,
    costWarnUsd: agent.costWarnUsd,
    costKillUsd: agent.costKillUsd,
    permissionMode: agent.permissionMode,
    initialCumulativeCostUsd: carriedCostUsd,
  });

  return { runId: params.runId };
}

/**
 * Poll runRegistry until the handle for `runId` is gone, signalling that
 * the child process has exited and its finalize() has run. Throws if it
 * doesn't happen within timeoutMs.
 */
async function waitForExit(runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (runRegistry.has(runId)) {
    if (Date.now() >= deadline) {
      throw new AppError(
        `previous subprocess for run ${runId} did not exit within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
