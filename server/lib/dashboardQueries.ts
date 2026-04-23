import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditLog, runs, tasks, users } from "@/server/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Read-only queries that back the /dashboard tiles. All scoped by viewer:
//   - admin sees everything
//   - member sees only tasks they own (+ audit events they acted on)
//
// Every function is pure SQL; tiles render whatever it returns. Tests use
// in-memory DB or a sandbox path.
// ─────────────────────────────────────────────────────────────────────────────

export type ViewerScope = {
  userId: string;
  role: "admin" | "member" | "viewer";
};

const STUCK_HEARTBEAT_MS = 90 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Helper: list of task IDs visible to the viewer. */
function visibleTaskIds(scope: ViewerScope): string[] | "all" {
  if (scope.role === "admin" || scope.role === "viewer") return "all";
  const rows = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.ownerId, scope.userId))
    .all();
  return rows.map((r) => r.id);
}

/** Ops-health tile: live runs, stuck runs, error count last 24h. */
export function opsHealth(scope: ViewerScope) {
  const tasksFilter = visibleTaskIds(scope);
  const now = Date.now();
  const stuckThreshold = new Date(now - STUCK_HEARTBEAT_MS);
  const dayAgo = now - DAY_MS;

  const scopedRun = (extra?: typeof runs.$inferSelect extends infer _ ? unknown : never) => extra; // noop, keep type import alive

  // Live + awaiting
  const liveBaseQuery = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      tasksFilter === "all"
        ? inArray(runs.status, ["running", "awaiting_input"])
        : and(
            inArray(runs.status, ["running", "awaiting_input"]),
            inArray(runs.taskId, tasksFilter.length > 0 ? tasksFilter : [""]),
          ),
    );
  const live = liveBaseQuery.all().length;

  // Stuck = status=running AND (last_heartbeat_at < now-90s OR null + started>90s ago)
  const stuck = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.status, "running"),
        tasksFilter === "all"
          ? sql`1=1`
          : inArray(runs.taskId, tasksFilter.length > 0 ? tasksFilter : [""]),
        sql`(${runs.lastHeartbeatAt} IS NULL OR ${runs.lastHeartbeatAt} < ${stuckThreshold.getTime()})`,
        lt(runs.startedAt, stuckThreshold),
      ),
    )
    .all().length;

  // Errors: failed / cost_killed / interrupted in last 24h
  const errors24h = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["failed", "cost_killed", "interrupted"]),
        gt(runs.finishedAt, new Date(dayAgo)),
        isNotNull(runs.finishedAt),
        tasksFilter === "all"
          ? sql`1=1`
          : inArray(runs.taskId, tasksFilter.length > 0 ? tasksFilter : [""]),
      ),
    )
    .all().length;

  return { live, stuck, errors24h };
}

/** Cost-meter tile: today, week, per-agent breakdown. */
export function costMeter(scope: ViewerScope) {
  const tasksFilter = visibleTaskIds(scope);
  const now = Date.now();
  const startOfDay = new Date(now - (now % DAY_MS));
  const startOfWeek = new Date(now - 7 * DAY_MS);

  const whereScope = (from: Date) =>
    tasksFilter === "all"
      ? gt(runs.startedAt, from)
      : and(
          gt(runs.startedAt, from),
          inArray(runs.taskId, tasksFilter.length > 0 ? tasksFilter : [""]),
        );

  const sumUsd = (from: Date) => {
    const rows = db
      .select({ micros: runs.costUsdMicros })
      .from(runs)
      .where(whereScope(from))
      .all();
    const totalMicros = rows.reduce((sum, r) => sum + r.micros, 0);
    return totalMicros / 1_000_000;
  };

  const today = sumUsd(startOfDay);
  const week = sumUsd(startOfWeek);

  // Per-agent breakdown this week, top 3
  const agentRows = db
    .select({ agentId: runs.agentId, micros: runs.costUsdMicros })
    .from(runs)
    .where(whereScope(startOfWeek))
    .all();
  const byAgent = new Map<string, number>();
  for (const r of agentRows) {
    byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + r.micros);
  }
  const topAgents = [...byAgent.entries()]
    .map(([agentId, micros]) => ({ agentId, usd: micros / 1_000_000 }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 3);

  return { today, week, topAgents };
}

/** Throughput tile: lane entries per day, last 7 days. */
export function throughputByLane(scope: ViewerScope) {
  const tasksFilter = visibleTaskIds(scope);
  const weekAgo = new Date(Date.now() - 7 * DAY_MS);

  const rows = db
    .select({
      action: auditLog.action,
      ts: auditLog.ts,
      taskId: auditLog.taskId,
    })
    .from(auditLog)
    .where(
      and(
        sql`${auditLog.action} LIKE 'lane.enter.%'`,
        gt(auditLog.ts, weekAgo),
        tasksFilter === "all"
          ? sql`1=1`
          : inArray(auditLog.taskId, tasksFilter.length > 0 ? tasksFilter : [""]),
      ),
    )
    .all();

  // Bucket by lane id + day-of-week (0..6, day 0 = 6 days ago, day 6 = today).
  const LANES = ["ticket", "branch", "brainstorm", "plan", "review", "pr", "implement", "done"] as const;
  type Lane = (typeof LANES)[number];
  const byLane: Record<Lane, number[]> = Object.fromEntries(
    LANES.map((l) => [l, new Array(7).fill(0)]),
  ) as Record<Lane, number[]>;

  const dayZero = new Date();
  dayZero.setHours(0, 0, 0, 0);
  dayZero.setDate(dayZero.getDate() - 6);

  for (const r of rows) {
    const lane = r.action.replace("lane.enter.", "") as Lane;
    if (!(lane in byLane)) continue;
    const dayIdx = Math.floor(
      ((r.ts instanceof Date ? r.ts.getTime() : (r.ts as unknown as number)) -
        dayZero.getTime()) /
        DAY_MS,
    );
    if (dayIdx >= 0 && dayIdx <= 6) byLane[lane][dayIdx]! += 1;
  }

  const total = Object.values(byLane).reduce(
    (sum, arr) => sum + arr.reduce((s, n) => s + n, 0),
    0,
  );
  return { byLane, total, lanes: LANES };
}

/** Activity feed tile: recent state transitions + chat. */
export function activityFeed(scope: ViewerScope, limit = 20) {
  const tasksFilter = visibleTaskIds(scope);

  const rows = db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      taskId: auditLog.taskId,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorUserId, users.id))
    .where(
      tasksFilter === "all"
        ? sql`1=1`
        : sql`(
            ${auditLog.actorUserId} = ${scope.userId}
            OR ${auditLog.taskId} IN (${sql.join(
              (tasksFilter.length > 0 ? tasksFilter : [""]).map(
                (id) => sql`${id}`,
              ),
              sql`, `,
            )})
          )`,
    )
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .all();

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.getTime() : (r.ts as unknown as number),
    action: r.action,
    actor: r.actorName ?? r.actorEmail ?? "system",
    taskId: r.taskId,
  }));
}

export type OpsHealth = ReturnType<typeof opsHealth>;
export type CostMeter = ReturnType<typeof costMeter>;
export type Throughput = ReturnType<typeof throughputByLane>;
export type Activity = ReturnType<typeof activityFeed>;
