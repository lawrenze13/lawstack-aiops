import "server-only";
import {
  resolveAllCredentials,
  type ResolvedCreds,
  type ResolvedGitIdentity,
} from "@/server/integrations/credentials";
import { JiraClient } from "@/server/jira/client";
import { GithubClient } from "@/server/git/githubClient";

// RunContext — single creds binding for the lifetime of one run.
//
// Resolved once at run start (before any side-effecting Jira/GitHub
// calls) and threaded through every worker function that needs to
// hit an external service. Mid-run admin edits to the user's prefs
// don't affect in-flight runs because the resolved creds are
// snapshotted into this object at construction time.
//
// `jiraClient` / `githubClient` are pre-built when the corresponding
// service has at least an instance default; null when neither user
// nor instance has set creds. The caller can branch on null and
// either fail-fast (`credentials_not_configured`) or skip the call
// entirely (e.g. `getIssueComments` returns [] when no Jira).

export interface RunContext {
  /** The userId whose creds drive this run. Always the task's
   *  `ownerId`; null only for system-driven calls (cron, intake). */
  readonly ownerUserId: string | null;
  readonly creds: {
    readonly jira: ResolvedCreds<"jira">;
    readonly github: ResolvedCreds<"github">;
    readonly git: ResolvedGitIdentity;
  };
  /** Pre-built when source !== 'missing'. Construct your own from
   *  `ctx.creds.jira.value` if you need a fresh instance per call. */
  readonly jiraClient: JiraClient | null;
  readonly githubClient: GithubClient | null;
}

/**
 * Build a RunContext for the task owner identified by `ownerUserId`.
 * `null` resolves to instance defaults only — appropriate for
 * cron / intake / other system-driven callers.
 */
export function makeRunContext(ownerUserId: string | null): RunContext {
  const creds = resolveAllCredentials(ownerUserId);
  const jiraClient =
    creds.jira.source === "missing"
      ? null
      : new JiraClient({
          baseUrl: creds.jira.value.baseUrl,
          email: creds.jira.value.email,
          apiToken: String(creds.jira.value.apiToken),
        });
  const githubClient =
    creds.github.source === "missing"
      ? null
      : new GithubClient({ token: String(creds.github.value.token) });
  return Object.freeze({ ownerUserId, creds, jiraClient, githubClient });
}

/**
 * Extract the flat-column source values for `runs.jira_token_source`
 * and `runs.github_token_source`. `'missing'` collapses to NULL so
 * existing legacy queries see consistent shape.
 */
export function tokenSourcesForRun(ctx: RunContext): {
  jiraTokenSource: "user" | "instance" | null;
  githubTokenSource: "user" | "instance" | null;
} {
  return {
    jiraTokenSource:
      ctx.creds.jira.source === "missing" ? null : ctx.creds.jira.source,
    githubTokenSource:
      ctx.creds.github.source === "missing" ? null : ctx.creds.github.source,
  };
}
