import { eq } from "drizzle-orm";
import { z } from "zod";
import { withAuth } from "@/server/lib/route";
import { BadRequest, Conflict, Forbidden, NotFound } from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { prRecords, runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { runRegistry } from "@/server/worker/runRegistry";
import { removeWorktreeForTask } from "@/server/git/worktree";
import { deleteRemoteBranchAndClosePr } from "@/server/git/remoteCleanup";

export const runtime = "nodejs";

export const GET = withAuth(async ({ req }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFound("task not found");
  return { task };
});

const LANES = [
  "ticket",
  "branch",
  "brainstorm",
  "plan",
  "review",
  "pr",
  "implement",
  "done",
] as const;

const PatchBody = z.object({
  lane: z.enum(LANES),
});

export const PATCH = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) throw new BadRequest("missing task id");

  const body = PatchBody.parse(await req.json());

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFound("task not found");
  if (task.status === "archived") {
    throw new Conflict("task is archived; cannot move it");
  }
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can move a task");
  }

  if (task.currentLane === body.lane) {
    // No-op — drop in the same lane (reorder-within-lane would go here).
    return { ok: true, unchanged: true, task };
  }

  // Lightweight transition guard: moving to 'pr' requires Brainstorm + Plan
  // artifacts to exist (the Approve & PR gate). Moving between other lanes
  // is always allowed — the lane is organizational, not behavioral.
  if (body.lane === "pr") {
    const { artifacts } = await import("@/server/db/schema");
    const { sql } = await import("drizzle-orm");
    const rows = db
      .select({ kind: artifacts.kind })
      .from(artifacts)
      .where(sql`${artifacts.taskId} = ${id}`)
      .all();
    const kinds = new Set(rows.map((r) => r.kind));
    if (!kinds.has("brainstorm") || !kinds.has("plan")) {
      throw new Conflict(
        "cannot move to PR lane until Brainstorm + Plan artifacts exist",
      );
    }
  }

  const now = new Date();
  db.update(tasks)
    .set({ currentLane: body.lane, updatedAt: now })
    .where(eq(tasks.id, id))
    .run();

  audit({
    action: "task.lane_changed",
    actorUserId: user.id,
    taskId: id,
    payload: { from: task.currentLane, to: body.lane },
  });

  const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return { ok: true, task: updated };
});

export const DELETE = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can archive a task");
  }
  if (task.status === "archived") {
    // Idempotent — already archived. Nothing to do.
    return { ok: true, alreadyArchived: true };
  }

  // 1. Stop any live runs for this task (SIGTERM → 5s → SIGKILL).
  const liveRunRows = db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, id))
    .all();
  let stoppedCount = 0;
  for (const r of liveRunRows) {
    const handle = runRegistry.get(r.id);
    if (handle) {
      handle.stop("shutdown");
      stoppedCount++;
    }
  }

  // Remote cleanup flag — opt-in via ?deleteRemote=1. When set, we close
  // any PR on the task's branch and delete the remote branch AFTER stopping
  // subprocesses but BEFORE we blow away the local worktree (the worktree
  // is our working copy for running `gh pr close` / `git push --delete`).
  const deleteRemote = url.searchParams.get("deleteRemote") === "1";
  let remoteResult: Awaited<ReturnType<typeof deleteRemoteBranchAndClosePr>> | null =
    null;
  if (deleteRemote) {
    const pr = db
      .select({ branch: prRecords.branch, prUrl: prRecords.prUrl })
      .from(prRecords)
      .where(eq(prRecords.taskId, id))
      .get();
    if (pr) {
      remoteResult = await deleteRemoteBranchAndClosePr(id, pr.branch, pr.prUrl);
    }
  }

  // 2. Remove the worktree from disk (best-effort; logs warnings).
  const { removed, warnings } = await removeWorktreeForTask(id);

  // 3. Mark the task archived. Runs / messages / artifacts are retained so
  //    the audit trail stays intact. A future `DELETE /api/admin/tasks/:id`
  //    route could hard-delete, but that's an admin-only escape hatch.
  const now = new Date();
  db.update(tasks)
    .set({ status: "archived", updatedAt: now, currentRunId: null })
    .where(eq(tasks.id, id))
    .run();

  audit({
    action: "task.archived",
    actorUserId: user.id,
    taskId: id,
    payload: {
      jiraKey: task.jiraKey,
      stoppedLiveRuns: stoppedCount,
      worktreeRemoved: removed,
      worktreeWarnings: warnings,
      deleteRemote,
      remoteResult,
    },
  });

  return {
    ok: true,
    taskId: id,
    stoppedLiveRuns: stoppedCount,
    worktreeRemoved: removed,
    worktreeWarnings: warnings,
    remote: remoteResult,
  };
});
