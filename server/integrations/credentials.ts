import "server-only";
import { getConfig } from "@/server/lib/config";
import { readUserPrefs } from "@/server/lib/userPrefs";
import {
  type CredsFor,
  type GitIdentity,
  type GithubMem,
  type JiraMem,
  type ServiceKey,
  SERVICE_KEYS,
} from "@/server/integrations/credentialsSchema";

// Per-user credential resolver. Layers user_prefs.credentialsJson
// (already-decrypted memory shape, returned by readUserPrefs) over
// instance-wide values from the `settings` table.
//
// Mirrors the discriminated-union + lazy-require pattern documented
// in docs/adrs/0001-resolver-pattern.md and the per-user-tokens plan.
//
// Failure mode contract:
//   - userId === null              → instance-only resolution (system-driven calls)
//   - no user_prefs row            → fall through to instance silently
//   - decryption failure on a field → fall through to instance for that field
//                                     (audit lives in userPrefs decrypt path)
//   - instance also missing        → { source: 'missing', value: null }
//
// Hardcoded git-author fallback mirrors the historic constants in
// server/git/approve.ts:148-152 — used when neither user nor instance
// has set a git identity.

const HARDCODED_GIT_FALLBACK: GitIdentity = {
  name: "lawstack-aiops",
  email: "ai-ops@multiportal.io",
};

// ─── Discriminated union ──────────────────────────────────────────────────────

export type CredSource = "user" | "instance" | "missing";

export type ResolvedCreds<S extends ServiceKey> =
  | { service: S; source: "user" | "instance"; value: CredsFor<S> }
  | { service: S; source: "missing"; value: null };

// Specialised "git" variant: this never resolves to `missing` because
// the hardcoded fallback always supplies one. We surface a third
// `source: 'default'` to make that explicit.
export type ResolvedGitIdentity =
  | { service: "git"; source: "user" | "instance"; value: GitIdentity }
  | { service: "git"; source: "default"; value: GitIdentity };

// ─── Resolver ─────────────────────────────────────────────────────────────────

export function resolveCredentials<S extends ServiceKey>(
  userId: string | null,
  service: S,
): ResolvedCreds<S> {
  if (service === "jira") return resolveJira(userId) as ResolvedCreds<S>;
  if (service === "github") return resolveGithub(userId) as ResolvedCreds<S>;
  if (service === "git") return resolveGit(userId) as ResolvedCreds<S>;
  // Exhaustiveness — if a future ServiceKey is added without a branch
  // here, this throw fires at runtime AND fails type-check above.
  const _exhaustive: never = service;
  throw new Error(`unknown service: ${String(_exhaustive)}`);
}

export function resolveAllCredentials(userId: string | null): {
  jira: ResolvedCreds<"jira">;
  github: ResolvedCreds<"github">;
  git: ResolvedGitIdentity;
} {
  return {
    jira: resolveJira(userId),
    github: resolveGithub(userId),
    git: resolveGit(userId),
  };
}

// ─── Per-service implementations ──────────────────────────────────────────────

function resolveJira(userId: string | null): ResolvedCreds<"jira"> {
  // 1. User overlay.
  if (userId) {
    const user = readUserCredentials(userId);
    if (user?.jira && jiraIsComplete(user.jira)) {
      return { service: "jira", source: "user", value: user.jira };
    }
  }

  // 2. Instance default.
  const instance = readInstanceJira();
  if (instance) return { service: "jira", source: "instance", value: instance };

  // 3. Missing.
  return { service: "jira", source: "missing", value: null };
}

function resolveGithub(userId: string | null): ResolvedCreds<"github"> {
  if (userId) {
    const user = readUserCredentials(userId);
    if (user?.github && user.github.token) {
      return { service: "github", source: "user", value: user.github };
    }
  }

  const instance = readInstanceGithub();
  if (instance)
    return { service: "github", source: "instance", value: instance };

  return { service: "github", source: "missing", value: null };
}

function resolveGit(userId: string | null): ResolvedGitIdentity {
  if (userId) {
    const user = readUserCredentials(userId);
    if (user?.git) return { service: "git", source: "user", value: user.git };
  }

  // No instance-default git identity setting today — Phase 4 may add
  // one ("instance-wide default git author"). For v1 we go straight
  // to the hardcoded fallback when the user hasn't set one.
  return { service: "git", source: "default", value: HARDCODED_GIT_FALLBACK };
}

// ─── Lazy-required dependency reads ───────────────────────────────────────────

function readUserCredentials(
  userId: string,
): {
  jira?: JiraMem;
  github?: GithubMem;
  git?: GitIdentity;
} | null {
  try {
    const prefs = readUserPrefs(userId);
    return prefs.credentials;
  } catch {
    return null;
  }
}

function readInstanceJira(): JiraMem | null {
  try {
    const baseUrl = getConfig("JIRA_BASE_URL");
    const email = getConfig("JIRA_EMAIL");
    const apiToken = getConfig("JIRA_API_TOKEN");
    if (!baseUrl || !email || !apiToken) return null;
    return {
      baseUrl,
      email,
      // The settings layer holds the plaintext post-decrypt (see Phase 2);
      // for now (Phase 1) the layer hasn't yet been wired through, but
      // the type matches.
      apiToken: apiToken as unknown as JiraMem["apiToken"],
    };
  } catch {
    return null;
  }
}

function readInstanceGithub(): GithubMem | null {
  try {
    const token = getConfig("GITHUB_TOKEN");
    if (!token) return null;
    return { token: token as unknown as GithubMem["token"] };
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jiraIsComplete(j: Partial<JiraMem>): j is JiraMem {
  return Boolean(j.baseUrl && j.email && j.apiToken);
}

// Re-export for convenience.
export { SERVICE_KEYS };
export type { ServiceKey };
