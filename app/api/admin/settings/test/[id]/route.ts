import { withAuth } from "@/server/lib/route";
import { Forbidden } from "@/server/lib/errors";
import { runTestAction } from "@/server/lib/settingsTestActions";

export const runtime = "nodejs";

/**
 * POST /api/admin/settings/test/[id]
 *
 * Admin-gated version of the test-action dispatcher. Used by
 * /admin/settings page to re-verify external services after an edit.
 */
export const POST = withAuth(async ({ req, user }) => {
  if (user.role !== "admin") throw new Forbidden("admin only");

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1] ?? "";

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine
  }

  return runTestAction(id, payload);
});
