import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth/config";
import { audit } from "@/server/auth/audit";
import { rateLimit } from "@/server/lib/rateLimit";
import { checkOriginCsrf } from "@/server/lib/csrfCheck";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
} from "@/server/lib/credentialsLockout";
import { TEST_HANDLERS } from "@/server/lib/userCredentialsTestActions";
import {
  SERVICE_KEYS,
  type ServiceKey,
} from "@/server/integrations/credentialsSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/profile/credentials/test/[service]
 *
 * Test the user's UNSAVED credentials against the provider. Used by the
 * /profile Connections cards to validate before Save.
 *
 * Defences:
 *   - Auth: any signed-in user (own creds only).
 *   - CSRF: Origin header must match AUTH_URL.
 *   - Rate limit: 5/min and 30/hour per (user, service).
 *   - Lockout: 5 consecutive failures in 1h → 30 min lockout.
 *
 * Audit: emits credentials.tested with {service, userId, outcome, from_ip}.
 * Never logs the input payload or any provider response body.
 */
export async function POST(req: NextRequest) {
  // ─── Auth ───
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ─── CSRF ───
  const csrf = checkOriginCsrf(req);
  if (!csrf.ok) {
    // Deliberate: do NOT audit CSRF probes. They're high-volume noise
    // (every cross-origin scanner hits them) and we don't want them
    // drowning the audit log.
    return NextResponse.json(
      { error: "forbidden", message: csrf.reason },
      { status: 403 },
    );
  }

  // ─── Service ───
  const service = extractService(req.url);
  if (!service) {
    return NextResponse.json(
      { error: "bad_request", message: "unknown service" },
      { status: 400 },
    );
  }
  const handler = TEST_HANDLERS[service];
  if (!handler) {
    return NextResponse.json(
      { error: "bad_request", message: `service '${service}' has no test handler` },
      { status: 400 },
    );
  }

  // ─── Lockout ───
  const lock = checkLockout(userId, service);
  if (lock.locked) {
    return NextResponse.json(
      {
        error: "locked_out",
        message: "Too many failed attempts. Try again later.",
        retryAfterSec: lock.retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(lock.retryAfterSec) },
      },
    );
  }

  // ─── Rate limit ───
  // Two windows: short burst (5/min) + sustained (30/hour). Both must allow.
  const minWindow = rateLimit(`cred-test:${userId}:${service}:min`, 5, 60_000);
  if (!minWindow.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many tests in the last minute.",
        retryAfterSec: minWindow.retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(minWindow.retryAfterSec) },
      },
    );
  }
  const hourWindow = rateLimit(`cred-test:${userId}:${service}:hr`, 30, 60 * 60_000);
  if (!hourWindow.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many tests in the last hour.",
        retryAfterSec: hourWindow.retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(hourWindow.retryAfterSec) },
      },
    );
  }

  // ─── Body ───
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "body must be JSON" },
      { status: 400 },
    );
  }

  // ─── Dispatch ───
  const result = await handler(payload);

  // ─── Audit + lockout state ───
  const fromIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;
  audit({
    action: "credentials.tested",
    actorUserId: userId,
    actorIp: fromIp,
    payload: {
      service,
      outcome: result.ok ? "success" : (result.reason ?? "unknown"),
    },
  });
  if (result.ok) {
    recordSuccess(userId, service);
  } else {
    recordFailure(userId, service);
    // After this failure, did we cross the threshold? Audit it loudly.
    const post = checkLockout(userId, service);
    if (post.locked) {
      audit({
        action: "credentials.test_locked_out",
        actorUserId: userId,
        actorIp: fromIp,
        payload: { service, retryAfterSec: post.retryAfterSec },
      });
    }
  }

  return NextResponse.json(result);
}

function extractService(url: string): ServiceKey | null {
  // Last segment of /api/profile/credentials/test/<service>
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
