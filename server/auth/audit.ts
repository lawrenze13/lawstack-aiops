import "server-only";
import { db } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";

// Lightweight wrapper used by auth callbacks and route handlers. Never throws —
// audit failures should not block user actions.
export function audit(opts: {
  action: string;
  actorUserId?: string | null;
  actorIp?: string | null;
  taskId?: string | null;
  runId?: string | null;
  payload?: unknown;
}): void {
  try {
    db.insert(auditLog)
      .values({
        action: opts.action,
        actorUserId: opts.actorUserId ?? null,
        actorIp: opts.actorIp ?? null,
        taskId: opts.taskId ?? null,
        runId: opts.runId ?? null,
        payloadJson: opts.payload === undefined ? null : JSON.stringify(opts.payload),
      })
      .run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("audit log write failed", { action: opts.action, err });
  }
}
