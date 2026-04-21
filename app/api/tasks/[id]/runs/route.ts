import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { startRun } from "@/server/worker/startRun";
import type { Lane } from "@/server/agents/registry";

export const runtime = "nodejs";

const Body = z.object({
  lane: z.enum(["brainstorm", "plan", "review", "pr", "implement"]),
  agentId: z.string().min(1),
  resumeSessionId: z.string().min(1).optional(),
  /** When true and lane==='plan', builds the amendment prompt. */
  amendFromReview: z.boolean().optional(),
  /** When true and lane==='implement', agent pauses before each Bash. */
  interactive: z.boolean().optional(),
});

export const POST = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const body = Body.parse(await req.json());
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can start a run");
  }

  const result = await startRun({
    taskId,
    lane: body.lane as Lane,
    agentId: body.agentId,
    resumeSessionId: body.resumeSessionId,
    amendFromReview: body.amendFromReview,
    interactive: body.interactive,
    initiator: { userId: user.id, kind: "user" },
  });

  return { runId: result.runId, taskId, lane: result.lane, agentId: result.agentId };
});
