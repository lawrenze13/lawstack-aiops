import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth/config";
import { audit } from "@/server/auth/audit";
import { checkOriginCsrf } from "@/server/lib/csrfCheck";
import {
  asPlaintext,
  encrypt,
  type Ciphertext,
} from "@/server/lib/encryption";
import {
  credentialAad,
  readUserPrefs,
  writeUserPrefs,
} from "@/server/lib/userPrefs";
import {
  TEST_HANDLERS,
  type TestResult,
} from "@/server/lib/userCredentialsTestActions";
import {
  SERVICE_KEYS,
  GitIdentity,
  type ServiceKey,
  type UserCredentialsDisk,
} from "@/server/integrations/credentialsSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/profile/credentials/save/[service]
 *
 * Persist the user's credentials for a single service. Re-runs the
 * test handler as a defence-in-depth check (UI may have raced or
 * skipped the Test button). Encrypts secret fields with AAD bound to
 * `userId + fieldPath` so cross-row / cross-field replay is rejected
 * by GCM auth-tag verification.
 *
 * Audit: emits credentials.set with {service, userId, tokenFingerprint}.
 * The fingerprint is sha256(token).slice(0,16) — operator-forensics
 * identifier, NOT the token itself.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
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

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "body must be JSON" },
      { status: 400 },
    );
  }

  // ─── Defence-in-depth: re-run the test before persisting ───
  // Git identity has no test (nothing external to validate against);
  // the zod schema validates shape. Jira / GitHub run their handler.
  if (service !== "git") {
    const handler = TEST_HANDLERS[service];
    if (!handler) {
      return NextResponse.json(
        { error: "bad_request", message: `service '${service}' not saveable` },
        { status: 400 },
      );
    }
    const test = await handler(payload);
    if (!test.ok) {
      return NextResponse.json(
        { error: "test_failed", reason: test.reason, message: test.message },
        { status: 400 },
      );
    }
    // Persist using the test result + payload.
    return persistAndRespond(userId, service, payload, test, req);
  }

  // ─── Git identity ───
  return persistGitIdentity(userId, payload, req);
}

async function persistAndRespond(
  userId: string,
  service: Exclude<ServiceKey, "git">,
  payload: Record<string, unknown>,
  test: TestResult,
  req: Request,
): Promise<Response> {
  // Build the disk-shape patch — encrypts secret subfields with the
  // AAD that includes userId + fieldPath.
  const current = readUserPrefs(userId).credentials;
  let patch: UserCredentialsDisk;
  let tokenFingerprint: string;

  if (service === "jira") {
    const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/$/, "");
    const email = String(payload.email ?? "").trim();
    const apiToken = String(payload.apiToken ?? "");
    if (!baseUrl || !email || !apiToken) {
      return NextResponse.json(
        { error: "bad_request", message: "missing required fields" },
        { status: 400 },
      );
    }
    const ct: Ciphertext = encrypt(
      asPlaintext(apiToken),
      credentialAad(userId, "jira.apiToken"),
    );
    const details = (test.details ?? {}) as {
      displayName?: string | null;
      accountId?: string | null;
      emailAddress?: string | null;
    };
    patch = {
      ...buildDiskFromCurrent(userId, current),
      jira: {
        baseUrl,
        email,
        apiToken: ct,
        ...(details.displayName ? { displayName: details.displayName } : {}),
        ...(details.accountId ? { accountId: details.accountId } : {}),
      },
    };
    tokenFingerprint = fingerprint(apiToken);
  } else {
    // service === "github"
    const token = String(payload.token ?? "");
    if (!token) {
      return NextResponse.json(
        { error: "bad_request", message: "missing token" },
        { status: 400 },
      );
    }
    const ct: Ciphertext = encrypt(
      asPlaintext(token),
      credentialAad(userId, "github.token"),
    );
    const details = (test.details ?? {}) as { login?: string };
    patch = {
      ...buildDiskFromCurrent(userId, current),
      github: {
        token: ct,
        ...(details.login ? { login: details.login } : {}),
      },
    };
    tokenFingerprint = fingerprint(token);
  }

  writeUserPrefs(userId, { credentials: patch });

  audit({
    action: "credentials.set",
    actorUserId: userId,
    actorIp: extractIp(req),
    payload: { service, tokenFingerprint },
  });

  return NextResponse.json({ saved: true });
}

async function persistGitIdentity(
  userId: string,
  payload: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const parsed = GitIdentity.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: "invalid git identity",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }
  const current = readUserPrefs(userId).credentials;
  const patch: UserCredentialsDisk = {
    ...buildDiskFromCurrent(userId, current),
    git: parsed.data,
  };
  writeUserPrefs(userId, { credentials: patch });

  audit({
    action: "credentials.set",
    actorUserId: userId,
    actorIp: extractIp(req),
    payload: { service: "git" },
  });
  return NextResponse.json({ saved: true });
}

/**
 * Re-encrypt all OTHER service blocks from the user's existing memory
 * shape so we can splice in the new one. We can't read the on-disk
 * ciphertext directly without decrypting (readUserPrefs already did
 * that), so we re-encrypt — which is fine, AES-GCM is fast and per-row
 * IVs mean ciphertext rotates harmlessly.
 */
function buildDiskFromCurrent(
  userId: string,
  current: ReturnType<typeof readUserPrefs>["credentials"],
): UserCredentialsDisk {
  const out: UserCredentialsDisk = {};
  if (current.jira) {
    out.jira = {
      baseUrl: current.jira.baseUrl,
      email: current.jira.email,
      apiToken: encrypt(
        asPlaintext(String(current.jira.apiToken)),
        credentialAad(userId, "jira.apiToken"),
      ),
      ...(current.jira.displayName ? { displayName: current.jira.displayName } : {}),
      ...(current.jira.accountId ? { accountId: current.jira.accountId } : {}),
    };
  }
  if (current.github) {
    out.github = {
      token: encrypt(
        asPlaintext(String(current.github.token)),
        credentialAad(userId, "github.token"),
      ),
      ...(current.github.login ? { login: current.github.login } : {}),
    };
  }
  if (current.git) out.git = current.git;
  return out;
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function extractIp(req: Request): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null
  );
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
