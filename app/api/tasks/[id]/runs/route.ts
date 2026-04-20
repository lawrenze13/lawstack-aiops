import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Conflict, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { artifacts, runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { ensureWorktree } from "@/server/git/worktree";
import { getAgent, snapshotAgent, type Lane } from "@/server/agents/registry";
import { syncAgentRegistry } from "@/server/agents/sync";
import { spawnAgent } from "@/server/worker/spawnAgent";

export const runtime = "nodejs";

const Body = z.object({
  lane: z.enum(["brainstorm", "plan", "review", "pr"]),
  agentId: z.string().min(1),
  /** Resume an existing Claude session (e.g., after server restart). */
  resumeSessionId: z.string().min(1).optional(),
});

const IDEMPOTENCY_WINDOW_MS = 10_000;

export const POST = withAuth(async ({ req, user }) => {
  syncAgentRegistry();

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/tasks/[id]/runs — id is two before the trailing 'runs'
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const body = Body.parse(await req.json());
  if (body.lane === "pr") throw new BadRequest("PR lane is not agent-driven; use Approve & PR");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (task.status === "archived") throw new Conflict("task is archived");

  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can start a run");
  }

  const agent = getAgent(body.agentId);
  if (!agent) throw new BadRequest(`unknown agent: ${body.agentId}`);
  if (!agent.lanes.includes(body.lane as Lane)) {
    throw new BadRequest(`agent ${agent.id} does not support lane ${body.lane}`);
  }

  // Idempotency: reject duplicate within the window for the same task+lane.
  const recentDup = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.lane, body.lane),
        gt(runs.startedAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS)),
        isNull(runs.supersededAt),
      ),
    )
    .limit(1)
    .all();
  if (recentDup.length > 0) {
    throw new Conflict(`a run for ${body.lane} was started within the last 10s`);
  }

  // Worktree (creates on first call; idempotent on subsequent runs).
  let worktree;
  try {
    worktree = await ensureWorktree(task.id, task.jiraKey);
  } catch (err) {
    if (err instanceof Conflict) throw err;
    throw new BadRequest(`failed to provision worktree: ${(err as Error).message}`);
  }

  // Build the prompt with prior artifacts (Plan needs Brainstorm, etc.).
  const priorArtifacts = db
    .select({ kind: artifacts.kind, markdown: artifacts.markdown, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(eq(artifacts.taskId, task.id))
    .orderBy(desc(artifacts.createdAt))
    .all();

  const prompt = agent.buildPrompt({
    jiraKey: task.jiraKey,
    title: task.title,
    description: task.descriptionMd,
    priorArtifacts: priorArtifacts.map((a) => ({ kind: a.kind, markdown: a.markdown })),
  });

  const runId = randomUUID();
  const sessionId = randomUUID();
  const now = new Date();

  // Mark any prior live run for this lane as superseded so the lane points
  // at the new run unambiguously.
  db.update(runs)
    .set({ supersededAt: now })
    .where(
      and(eq(runs.taskId, taskId), eq(runs.lane, body.lane), isNull(runs.supersededAt)),
    )
    .run();

  db.insert(runs)
    .values({
      id: runId,
      taskId,
      lane: body.lane,
      agentId: agent.id,
      agentConfigSnapshotJson: snapshotAgent(agent),
      claudeSessionId: body.resumeSessionId ?? sessionId,
      status: "running",
      startedAt: now,
      lastHeartbeatAt: now,
    })
    .run();

  db.update(tasks)
    .set({ currentLane: body.lane, currentRunId: runId, updatedAt: now })
    .where(eq(tasks.id, taskId))
    .run();

  audit({
    action: "run.started_request",
    actorUserId: user.id,
    taskId,
    runId,
    payload: { lane: body.lane, agentId: agent.id, resume: !!body.resumeSessionId },
  });

  spawnAgent({
    runId,
    taskId,
    prompt,
    sessionId,
    model: agent.model,
    worktreePath: worktree.path,
    resumeSessionId: body.resumeSessionId,
  });

  return { runId, taskId, lane: body.lane, agentId: agent.id };
});
