import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth/config";
import { audit } from "@/server/auth/audit";
import { checkOriginCsrf } from "@/server/lib/csrfCheck";
import {
  clearUserCredentialService,
  readUserPrefs,
} from "@/server/lib/userPrefs";
import {
  SERVICE_KEYS,
  type ServiceKey,
} from "@/server/integrations/credentialsSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/profile/credentials/[service]
 *
 * Returns the user's CURRENT credentials state for `service`, with
 * secret subfields **redacted**. Used by the /profile Connections
 * cards to render existing values on page load.
 *
 * Shape per service:
 *   - jira:   { configured: bool, baseUrl?, email?, displayName?, tokenLast4? }
 *   - github: { configured: bool, login?, tokenLast4? }
 *   - git:    { configured: bool, name?, email? }
 *
 * `tokenLast4` is the last 4 chars of the plaintext token. Disclosing
 * this much is acceptable — operators see it in their own browser,
 * not over the wire to admin endpoints.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const service = extractService(req.url);
  if (!service) {
    return NextResponse.json(
      { error: "bad_request", message: "unknown service" },
      { status: 400 },
    );
  }

  const creds = readUserPrefs(userId).credentials;

  if (service === "jira") {
    if (!creds.jira) return NextResponse.json({ configured: false });
    return NextResponse.json({
      configured: true,
      baseUrl: creds.jira.baseUrl,
      email: creds.jira.email,
      displayName: creds.jira.displayName ?? null,
      accountId: creds.jira.accountId ?? null,
      tokenLast4: last4(String(creds.jira.apiToken)),
    });
  }

  if (service === "github") {
    if (!creds.github) return NextResponse.json({ configured: false });
    return NextResponse.json({
      configured: true,
      login: creds.github.login ?? null,
      tokenLast4: last4(String(creds.github.token)),
    });
  }

  if (service === "git") {
    if (!creds.git) return NextResponse.json({ configured: false });
    return NextResponse.json({
      configured: true,
      name: creds.git.name,
      email: creds.git.email,
    });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
}

/**
 * DELETE /api/profile/credentials/[service]
 *
 * Clears credentials block for `service`. Self by default; admins may
 * pass `?for=<userId>` to clear another user's block (audited with
 * `clearedBy=<adminId>`). Audits credentials.cleared.
 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  const session_user = session?.user as
    | { id?: string; role?: string }
    | undefined;
  const actorUserId = session_user?.id;
  if (!actorUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const csrf = checkOriginCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json(
      { error: "forbidden", message: csrf.reason },
      { status: 403 },
    );
  }

  const service = extractService(req.url);
  if (!service) {
    return NextResponse.json(
      { error: "bad_request", message: "unknown service" },
      { status: 400 },
    );
  }

  // Admin clear-on-behalf via ?for=<userId>. Non-admins ignored.
  const url = new URL(req.url);
  const forParam = url.searchParams.get("for");
  let targetUserId = actorUserId;
  let clearedByAdmin = false;
  if (forParam && forParam !== actorUserId) {
    if (session_user?.role !== "admin") {
      return NextResponse.json(
        { error: "forbidden", message: "admin only for ?for=" },
        { status: 403 },
      );
    }
    targetUserId = forParam;
    clearedByAdmin = true;
  }

  clearUserCredentialService(targetUserId, service);

  audit({
    action: "credentials.cleared",
    actorUserId,
    actorIp:
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      null,
    payload: clearedByAdmin
      ? { service, targetUserId, clearedBy: actorUserId }
      : { service },
  });

  return NextResponse.json({ cleared: true, targetUserId });
}

function last4(s: string): string {
  if (!s || s.length < 4) return "***";
  return `***${s.slice(-4)}`;
}

function extractService(url: string): ServiceKey | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    return (SERVICE_KEYS as readonly string[]).includes(last)
      ? (last as ServiceKey)
      : null;
  } catch {
    return null;
  }
}
