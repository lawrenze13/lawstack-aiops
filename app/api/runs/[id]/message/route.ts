import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  TooManyRequests,
} from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { resumeRun } from "@/server/worker/resumeRun";
import { withRunLock } from "@/server/worker/chatMutex";
import { rateLimit } from "@/server/lib/rateLimit";

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

  // Rate limit: 20 messages per user per run per rolling 60s window.
  // Protects the worktree + Claude session from chat-spam races.
  const rl = rateLimit(`msg:${user.id}:${runId}`, 20, 60_000);
  if (!rl.ok) {
    audit({
      action: "chat.rate_limited",
      actorUserId: user.id,
      runId,
      payload: { retryAfterSec: rl.retryAfterSec },
    });
    throw new TooManyRequests(
      `You're sending messages too fast. Try again in ${rl.retryAfterSec}s.`,
      { retryAfterSec: rl.retryAfterSec },
    );
  }

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

    // Gate on DB status, NOT on registry presence. During the 10s NEEDS_INPUT
    // grace window the registry still has the subprocess handle (it's draining
    // gracefully), but status is already 'awaiting_input' and the user should
    // be able to reply. resumeRun handles the drain — it stops the old child
    // and awaits its exit before spawning the new one.
    if (run.status === "running") {
      throw new Conflict("run is still streaming; click Stop first or wait for completion");
    }

    const result = await resumeRun({
      runId,
      prompt: body.text,
      displayUserMessage: body.text,
      initiator: { userId: user.id, kind: "user" },
    });

    audit({
      action: "chat.message_sent",
      actorUserId: user.id,
      taskId: run.taskId,
      runId: result.runId,
      payload: {
        textPreview: body.text.slice(0, 80),
        clientRequestId: body.clientRequestId ?? null,
      },
    });

    return { runId: result.runId };
  });
});
