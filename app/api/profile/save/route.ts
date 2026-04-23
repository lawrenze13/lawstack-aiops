import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import {
  agentOverridesSchema,
  notificationsSchema,
  writeUserPrefs,
} from "@/server/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().min(1).max(80).optional(),
  agentOverrides: agentOverridesSchema.optional(),
  notifications: notificationsSchema.optional(),
});

/**
 * POST /api/profile/save — auth'd user edits their own profile.
 * Accepts any subset of { name, agentOverrides, notifications }.
 * Name writes to users.name; prefs go to user_prefs via UPSERT.
 * Returns 401 if unauthed; 400 if body fails validation.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const user = session?.user as { id?: string } | undefined;
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: (err as Error).message },
      { status: 400 },
    );
  }

  try {
    // users.name is the display name.
    if (typeof body.name === "string") {
      db.update(users).set({ name: body.name }).where(eq(users.id, user.id)).run();
    }

    // agent + notification prefs: UPSERT into user_prefs.
    if (body.agentOverrides !== undefined || body.notifications !== undefined) {
      writeUserPrefs(user.id, {
        agentOverrides: body.agentOverrides,
        notifications: body.notifications,
      });
    }
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Missing `user_prefs` table means the 0002 migration hasn't run
    // against this DB. Surface a self-diagnosing error instead of a
    // bare "500 Internal Server Error".
    if (msg.includes("no such table")) {
      return NextResponse.json(
        {
          error: "database not migrated",
          detail:
            "The user_prefs / user_notifications_seen tables don't exist. Run `npm run db:migrate` against this instance's DB, then try again.",
          originalError: msg,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "save failed", detail: msg },
      { status: 500 },
    );
  }

  audit({
    action: "profile.save",
    actorUserId: user.id,
    payload: { fields: Object.keys(body) },
  });

  return NextResponse.json({ ok: true });
}
