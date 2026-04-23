import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  auditLog,
  tasks,
  userNotificationsSeen,
  users,
} from "@/server/db/schema";

// Actions that surface as notifications. Other audit rows exist but
// aren't interesting to the operator's inbox (e.g. config saves).
const NOTIFY_ACTIONS = [
  "run.completed",
  "run.failed",
  "run.cost_killed",
  "run.interrupted",
  "run.awaiting_input",
  "chat.posted",
] as const;

export type ViewerScope = {
  userId: string;
  role: "admin" | "member" | "viewer";
};

/** Tasks visible to the viewer (members: owned; admins: all). */
function visibleTaskIds(scope: ViewerScope): string[] | "all" {
  if (scope.role === "admin" || scope.role === "viewer") return "all";
  const rows = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.ownerId, scope.userId))
    .all();
  return rows.map((r) => r.id);
}

function readLastSeenId(userId: string): number {
  try {
    const row = db
      .select({ v: userNotificationsSeen.lastSeenAuditId })
      .from(userNotificationsSeen)
      .where(eq(userNotificationsSeen.userId, userId))
      .get();
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

/** Unread count since last-seen, scoped to the viewer. */
export function unreadCount(scope: ViewerScope): number {
  const visible = visibleTaskIds(scope);
  const sinceId = readLastSeenId(scope.userId);

  const rows = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        gt(auditLog.id, sinceId),
        inArray(auditLog.action, [...NOTIFY_ACTIONS]),
        // Never show the viewer their own actions (they already know).
        sql`(${auditLog.actorUserId} IS NULL OR ${auditLog.actorUserId} != ${scope.userId})`,
        visible === "all"
          ? sql`1=1`
          : inArray(
              auditLog.taskId,
              visible.length > 0 ? visible : [""],
            ),
      ),
    )
    .all();

  return rows.length;
}

export type NotificationRow = {
  id: number;
  ts: number;
  action: string;
  taskId: string | null;
  actor: string;
  unread: boolean;
};

/** Last N matching events for the tray panel. */
export function listNotifications(
  scope: ViewerScope,
  limit = 50,
): NotificationRow[] {
  const visible = visibleTaskIds(scope);
  const sinceId = readLastSeenId(scope.userId);

  const rows = db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      action: auditLog.action,
      taskId: auditLog.taskId,
      actorUserId: auditLog.actorUserId,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorUserId, users.id))
    .where(
      and(
        inArray(auditLog.action, [...NOTIFY_ACTIONS]),
        sql`(${auditLog.actorUserId} IS NULL OR ${auditLog.actorUserId} != ${scope.userId})`,
        visible === "all"
          ? sql`1=1`
          : inArray(
              auditLog.taskId,
              visible.length > 0 ? visible : [""],
            ),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .all();

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.getTime() : (r.ts as unknown as number),
    action: r.action,
    taskId: r.taskId,
    actor: r.actorName ?? r.actorEmail ?? "system",
    unread: r.id > sinceId,
  }));
}

/** UPSERT last_seen_audit_id = MAX(audit_log.id) for the viewer. */
export function markAllRead(userId: string): { marked: number } {
  const top = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  const maxId = top?.id ?? 0;

  db.insert(userNotificationsSeen)
    .values({ userId, lastSeenAuditId: maxId })
    .onConflictDoUpdate({
      target: userNotificationsSeen.userId,
      set: { lastSeenAuditId: maxId, updatedAt: new Date() },
    })
    .run();

  return { marked: maxId };
}
