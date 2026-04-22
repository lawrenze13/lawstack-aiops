import { NextResponse, type NextRequest } from "next/server";
import { validateSetupToken } from "@/server/auth/setupToken";
import { handleSettingsWrite } from "@/server/lib/settingsWrite";

export const runtime = "nodejs";

/**
 * POST /api/setup/save?token=UUID
 *
 * Token-gated write path for the first-run wizard. Token validation runs
 * here (not in middleware) because middleware is Edge-runtime and can't
 * touch the sqlite DB. 403 if token invalid, expired, or users table is
 * no longer empty (admin already exists).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");
  if (!validateSetupToken(token)) {
    return NextResponse.json(
      { error: "invalid or expired setup token" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    // actorUserId is null during setup — no admin user exists yet.
    const result = await handleSettingsWrite(body, null);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
