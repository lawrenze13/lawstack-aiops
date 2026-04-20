import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Conflict, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { runRegistry } from "@/server/worker/runRegistry";
import { startRun } from "@/server/worker/startRun";
import { withRunLock } from "@/server/worker/chatMutex";
import type { Lane } from "@/server/agents/registry";

export const runtime = "nodejs";

const Body = z.object({
  text: z.string().trim().min(1).max(4000),
  /** Caller-generated UUID for idempotent retries. */
  clientRequestId: z.string().min(1).optional(),
});

export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/runs/[id]/message — id is two before 'message'
  const runId = segments[segments.length - 2];
  if (!runId) throw new BadRequest("missing run id");

  const body = Body.parse(await req.json());

  // All the critical section (read → validate → spawn) must serialise per run
  // so two tabs can't both win the "resume the session" race.
  return await withRunLock(runId, async () => {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new NotFound("run not found");
    if (!run.claudeSessionId) {
      throw new BadRequest("no Claude session captured for this run — cannot resume");
    }

    const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
    if (!task) throw new NotFound("task not found");
    if (user.role !== "admin" && task.ownerId !== user.id) {
      throw new Forbidden("only the card owner or an admin can chat on this run");
    }

    // You can only chat on a finalised run. If it's still streaming, the user
    // must Stop first (or wait). This avoids the "concurrent --resume" race
    // and matches the pause/resume pattern in ticket-worker.sh.
    if (runRegistry.has(runId)) {
      throw new Conflict("run is still streaming; click Stop first or wait for completion");
    }
    if (run.status === "running") {
      // DB says running but registry doesn't have it — orphan (should be rare
      // post-reconciler). Treat as blocked; user can click Resume.
      throw new Conflict("run is marked running but no live subprocess; click Resume instead");
    }

    const result = await startRun({
      taskId: run.taskId,
      lane: run.lane as Lane,
      agentId: run.agentId,
      resumeSessionId: run.claudeSessionId,
      overridePrompt: body.text,
      initiator: { userId: user.id, kind: "user" },
      // Chat messages must land even if they arrive quickly.
      bypassIdempotency: true,
    });

    audit({
      action: "chat.message_sent",
      actorUserId: user.id,
      taskId: run.taskId,
      runId: result.runId,
      payload: {
        parentRunId: runId,
        textPreview: body.text.slice(0, 80),
        clientRequestId: body.clientRequestId ?? null,
      },
    });

    return { runId: result.runId, parentRunId: runId };
  });
});
