import { withAuth } from "@/server/lib/route";
import { Forbidden } from "@/server/lib/errors";
import { handleSettingsWrite } from "@/server/lib/settingsWrite";

export const runtime = "nodejs";

/**
 * POST /api/admin/settings/save
 *
 * Admin-gated write path for ongoing /admin/settings edits. Same
 * handleSettingsWrite core as the /api/setup/save route; the gating
 * is the only difference.
 */
export const POST = withAuth(async ({ req, user }) => {
  if (user.role !== "admin") throw new Forbidden("admin only");

  const body = await req.json();
  return handleSettingsWrite(body, user.id);
});
