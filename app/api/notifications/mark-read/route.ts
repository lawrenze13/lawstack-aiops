import { NextResponse } from "next/server";
import { auth } from "@/server/auth/config";
import { audit } from "@/server/auth/audit";
import { markAllRead } from "@/server/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/mark-read — bumps the viewer's
 * user_notifications_seen.last_seen_audit_id to MAX(audit_log.id).
 * Zeros the unread count for the next poll.
 */
export async function POST() {
  const session = await auth();
  const user = session?.user as { id?: string } | undefined;
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { marked } = markAllRead(user.id);
  audit({
    action: "notifications.mark_read",
    actorUserId: user.id,
    payload: { lastSeenAuditId: marked },
  });
  return NextResponse.json({ ok: true, marked });
}
