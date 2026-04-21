import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { runRegistry } from "@/server/worker/runRegistry";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({ runId: z.string().min(1) });

export const POST = withAuth(async ({ req, user }) => {
  if (user.role !== "admin") {
    throw new Forbidden("admin only");
  }
  const body = Body.parse(await req.json());
  const run = db.select().from(runs).where(eq(runs.id, body.runId)).get();
  if (!run) throw new NotFound("run not found");

  const handle = runRegistry.get(body.runId);
  if (handle) {
    handle.stop("user");
  } else if (run.status === "running") {
    // Ghost row — no live subprocess but DB says running. Mark it interrupted.
    db.update(runs)
      .set({
        status: "interrupted",
        killedReason: "admin_kill",
        finishedAt: new Date(),
      })
      .where(eq(runs.id, body.runId))
      .run();
  } else {
    throw new BadRequest(`run is not running (status=${run.status})`);
  }

  audit({
    action: "admin.kill_run",
    actorUserId: user.id,
    runId: body.runId,
    taskId: run.taskId,
    payload: { hadLiveHandle: !!handle },
  });

  return { ok: true, runId: body.runId };
});
