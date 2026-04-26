import "server-only";
import { redactSecrets } from "@/server/lib/redactSecrets";
import { getConfig } from "@/server/lib/config";
import type { ServiceKey } from "@/server/integrations/credentialsSchema";

// Per-user credential test handlers. Mirrors the shape of
// server/lib/settingsTestActions.ts but takes the user's UNSAVED input
// directly (the admin variant pulls from the settings table).
//
// Sanitization rule: NEVER echo the provider's response body or any
// substring of the input back to the caller. Errors must be one of a
// fixed enum (`reason`); the optional `message` is a generic
// description only.

const TIMEOUT_MS = 10_000;

export type TokenProbeReason =
  | "invalid_credentials"
  | "forbidden"
  | "network_error"
  | "rate_limited"
  | "malformed_input";

export type TestResult = {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
  /** Set when ok=false; one of a fixed enum to prevent provider-message leaks. */
  reason?: TokenProbeReason;
};

// ─── Jira ─────────────────────────────────────────────────────────────────────

export type JiraTestPayload = {
  baseUrl?: unknown;
  email?: unknown;
  apiToken?: unknown;
};

export async function testJiraCreds(payload: JiraTestPayload): Promise<TestResult> {
  const baseUrl = String(payload.baseUrl ?? "").replace(/\/$/, "");
  const email = String(payload.email ?? "");
  const apiToken = String(payload.apiToken ?? "");
  if (!baseUrl || !email || !apiToken) {
    return {
      ok: false,
      reason: "malformed_input",
      message: "Fill in base URL, email, and API token first.",
    };
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    return {
      ok: false,
      reason: "malformed_input",
      message: "Base URL must start with https:// or http://.",
    };
  }

  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
        Accept: "application/json",
      },
    });
    clearTimeout(to);
    if (res.status === 401) {
      return {
        ok: false,
        reason: "invalid_credentials",
        message: "Jira rejected the credentials. Check the email + API token.",
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        reason: "forbidden",
        message: "Token is valid but lacks required Jira permissions.",
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        reason: "rate_limited",
        message: "Jira rate-limited this request. Try again in a minute.",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "network_error",
        message: `Jira returned HTTP ${res.status}.`,
      };
    }
    const me = (await res.json().catch(() => ({}))) as {
      accountId?: string;
      displayName?: string;
      emailAddress?: string;
    };
    if (!me.accountId) {
      return {
        ok: false,
        reason: "network_error",
        message: "Jira /myself response did not include an accountId.",
      };
    }
    return {
      ok: true,
      message: `Connected as ${me.displayName ?? me.emailAddress ?? "(name missing)"}`,
      details: {
        accountId: me.accountId,
        displayName: me.displayName ?? null,
        emailAddress: me.emailAddress ?? null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: "network_error",
      message: `Jira request failed: ${redactSecrets((err as Error).message)}`,
    };
  }
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export type GithubTestPayload = {
  token?: unknown;
};

export async function testGithubCreds(payload: GithubTestPayload): Promise<TestResult> {
  const token = String(payload.token ?? "");
  if (!token) {
    return {
      ok: false,
      reason: "malformed_input",
      message: "Paste a GitHub PAT first.",
    };
  }

  // Step 1: GET /user — confirms the token works at all.
  const userRes = await safeFetch(
    "https://api.github.com/user",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (userRes.ok === false) return userRes.result;
  const userJson = (await userRes.res.json().catch(() => ({}))) as {
    login?: string;
    id?: number;
  };
  if (!userJson.login) {
    return {
      ok: false,
      reason: "network_error",
      message: "GitHub /user response did not include a login.",
    };
  }

  // Step 2: GET /repos/{BASE_REPO} — confirms the token has Metadata
  // read on the configured base repo. Skipped (with warning) when
  // BASE_REPO is unset.
  const baseRepo = getConfig("BASE_REPO");
  let repoAccess:
    | { ok: true; fullName: string }
    | { ok: false; reason: "not_found" | "forbidden" | "network_error"; message: string }
    | null = null;
  if (baseRepo) {
    // BASE_REPO is a filesystem path on this box — derive the GitHub
    // owner/name by looking at the repo's origin URL.
    const remote = await deriveGithubRepoFromBaseRepo(baseRepo);
    if (remote) {
      const repoRes = await safeFetch(
        `https://api.github.com/repos/${remote}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (repoRes.ok === false) {
        if (repoRes.result.reason === "invalid_credentials") {
          return repoRes.result; // hard fail
        }
        // 404 from /repos/X means "either doesn't exist, or token can't see it".
        // GitHub returns 404 deliberately for inaccessible private repos to
        // avoid leaking existence — surface as "no access" to the user.
        repoAccess = {
          ok: false,
          reason: "not_found",
          message:
            "Token can't access this repo. Verify scope: Contents r/w, Pull requests r/w, Metadata read.",
        };
      } else {
        const j = (await repoRes.res.json().catch(() => ({}))) as { full_name?: string };
        repoAccess = { ok: true, fullName: j.full_name ?? remote };
      }
    }
  }

  return {
    ok: true,
    message: `Connected as @${userJson.login}`,
    details: {
      login: userJson.login,
      ...(repoAccess !== null ? { repoAccess } : {}),
      ...(baseRepo == null
        ? {
            warning:
              "BASE_REPO is unset. /repos scope check skipped — token may still lack PR-write permission.",
          }
        : {}),
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FetchOk = { ok: true; res: Response };
type FetchErr = { ok: false; result: TestResult };

async function safeFetch(url: string, init: RequestInit): Promise<FetchOk | FetchErr> {
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(to);
    if (res.status === 401) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "invalid_credentials",
          message: "GitHub rejected the token. Check that it hasn't expired.",
        },
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "forbidden",
          message: "GitHub denied the request. Token may lack required scopes.",
        },
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "rate_limited",
          message: "GitHub rate-limited this request. Try again shortly.",
        },
      };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: "network_error",
          message: `GitHub returned HTTP ${res.status}. Try again in a moment.`,
        },
      };
    }
    return { ok: true, res };
  } catch (err) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "network_error",
        message: `GitHub request failed: ${redactSecrets((err as Error).message)}`,
      },
    };
  }
}

/**
 * BASE_REPO is a filesystem path. Derive the GitHub `owner/name` by
 * reading the repo's `origin` remote URL via `git`. Returns null when
 * the repo doesn't exist, has no origin, or origin isn't a GitHub URL.
 */
async function deriveGithubRepoFromBaseRepo(baseRepo: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("git", ["-C", baseRepo, "config", "--get", "remote.origin.url"], {
      timeout: 5000,
    });
    const url = stdout.trim();
    // Match git@github.com:owner/repo.git AND https://github.com/owner/repo(.git)?
    const ssh = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (ssh) return ssh[1] ?? null;
    const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (https) return https[1] ?? null;
    return null;
  } catch {
    return null;
  }
}

// ─── Dispatch table ───────────────────────────────────────────────────────────

export const TEST_HANDLERS: Readonly<Record<ServiceKey, ((payload: unknown) => Promise<TestResult>) | null>> = Object.freeze({
  jira: (p: unknown) => testJiraCreds(p as JiraTestPayload),
  github: (p: unknown) => testGithubCreds(p as GithubTestPayload),
  // Git identity has nothing to validate against an external service —
  // the save endpoint validates shape via zod and persists directly.
  git: null,
});
