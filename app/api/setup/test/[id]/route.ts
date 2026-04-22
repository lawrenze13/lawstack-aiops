import { NextResponse, type NextRequest } from "next/server";
import { validateSetupToken } from "@/server/auth/setupToken";
import { runTestAction } from "@/server/lib/settingsTestActions";

export const runtime = "nodejs";

/**
 * POST /api/setup/test/[id]?token=UUID
 *
 * Runs a test action (jira | path | oauth-shape | cli | github-api |
 * github-workflow). Token-gated. Body is the test's payload (field
 * values needed by the handler).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");
  if (!validateSetupToken(token)) {
    return NextResponse.json(
      { error: "invalid or expired setup token" },
      { status: 403 },
    );
  }

  const { id } = await params;
  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine for e.g. `cli` which takes no args
  }

  const result = await runTestAction(id, payload);
  return NextResponse.json(result);
}
