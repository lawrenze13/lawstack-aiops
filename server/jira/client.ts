import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "@/server/lib/redactSecrets";
import { resolveCredentials } from "@/server/integrations/credentials";
import type { ServiceKey } from "@/server/integrations/credentialsSchema";
import type { AdfDocument } from "./adf";

// Atlassian Jira Cloud REST v3 client.
// Auth: Basic with `email:api_token` base64'd. Rate-limit headers logged
// on every response — see plan section "External references" for header list.
//
// Two surfaces:
//   - JiraClient class (preferred) — takes creds in the constructor;
//     callers in worker/runtime paths construct it from RunContext.
//   - Legacy free functions — instantiate a JiraClient backed by the
//     instance default. Phase 3 of the per-user-tokens plan refactors
//     remaining call sites onto the class form; they exist here for
//     backward compatibility.

// ─── Errors ─────────────────────────────────────────────────────────────────

export class JiraNotConfiguredError extends Error {
  constructor() {
    super(
      "Jira credentials are not configured (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN).",
    );
  }
}

/**
 * Thrown when an authenticated Jira call returns 401/403. The worker
 * catches this at the top of the run loop and marks the run failed
 * with `runs.killedReason = 'credentials_invalid:jira'`. Error messages
 * are pre-redacted via {@link redactSecrets}.
 */
export class CredentialsInvalidError extends Error {
  constructor(
    public readonly service: ServiceKey,
    public readonly status: number,
    detail?: string,
  ) {
    super(
      `${service} credentials rejected (HTTP ${status})${detail ? `: ${redactSecrets(detail)}` : ""}`,
    );
    this.name = "CredentialsInvalidError";
  }
}

// ─── Schemas (defensive — Jira returns more fields, we pluck what we need) ──

const JiraIssueLite = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.unknown().nullable().optional(),
    status: z
      .object({
        name: z.string(),
        statusCategory: z.object({ key: z.string() }).optional(),
      })
      .optional(),
    issuetype: z.object({ name: z.string() }).optional(),
  }),
});
export type JiraIssueLite = z.infer<typeof JiraIssueLite>;

const SearchResponse = z.object({
  issues: z.array(JiraIssueLite),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});

const CommentResponse = z.object({
  id: z.string(),
  self: z.string().optional(),
  created: z.string().optional(),
});

const TransitionsResponse = z.object({
  transitions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      to: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          statusCategory: z
            .object({ key: z.string().optional(), name: z.string().optional() })
            .optional(),
        })
        .optional(),
    }),
  ),
});
export type JiraTransition = z.infer<typeof TransitionsResponse>["transitions"][number];

const MyselfResponse = z.object({
  accountId: z.string(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
});

const IssueAssigneeResponse = z.object({
  fields: z.object({
    assignee: z
      .object({ accountId: z.string(), displayName: z.string().optional() })
      .nullable()
      .optional(),
  }),
});

const IssueCommentsResponse = z.object({
  comments: z.array(
    z.object({
      id: z.string(),
      body: z.unknown().optional(),
      author: z
        .object({
          displayName: z.string().optional(),
          emailAddress: z.string().optional(),
        })
        .optional(),
      created: z.string().optional(),
      updated: z.string().optional(),
    }),
  ),
  total: z.number().optional(),
});

export type JiraComment = {
  id: string;
  author: string;
  created: string;
  /** Plain-text rendering of the ADF body. */
  body: string;
};

export type JiraIdentity = {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
};

// ─── JiraCreds ──────────────────────────────────────────────────────────────

export type JiraCreds = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

// Per-token (not per-userId, per-process) cache of /myself responses so
// repeated calls within a run don't re-hit Jira. Keyed by SHA-256 of
// the apiToken — pivots when the token rotates, isolates across users.
const _myselfCache = new Map<string, Promise<JiraIdentity>>();

function cacheKeyForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// ─── JiraClient ─────────────────────────────────────────────────────────────

export class JiraClient {
  constructor(private readonly creds: JiraCreds) {
    if (!creds.baseUrl || !creds.email || !creds.apiToken) {
      throw new JiraNotConfiguredError();
    }
  }

  private authHeader(): string {
    const pair = Buffer.from(
      `${this.creds.email}:${this.creds.apiToken}`,
    ).toString("base64");
    return `Basic ${pair}`;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.creds.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
    logRateLimit(res, path);
    // Auth failures are typed; consumers can catch or let bubble.
    if (res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => "");
      throw new CredentialsInvalidError("jira", res.status, detail);
    }
    return res;
  }

  /** Search via JQL. Uses the new /search/jql endpoint. */
  async searchJql(
    jql: string,
    fields: string[] = ["summary", "status", "issuetype"],
    maxResults = 25,
  ): Promise<JiraIssueLite[]> {
    const params = new URLSearchParams({
      jql,
      fields: fields.join(","),
      maxResults: String(maxResults),
    });
    const res = await this.fetch(`/rest/api/3/search/jql?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `jira search failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
      );
    }
    const json = await res.json();
    return SearchResponse.parse(json).issues;
  }

  /** Fetch a single issue by key. Returns null on 404. */
  async getIssue(key: string): Promise<JiraIssueLite | null> {
    const res = await this.fetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `jira getIssue failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
      );
    }
    return JiraIssueLite.parse(await res.json());
  }

  /** Fetch comments on a Jira issue (oldest-first). Quiet on errors. */
  async getIssueComments(key: string, limit = 50): Promise<JiraComment[]> {
    const { adfToPlainText } = await import("./adf");
    try {
      const res = await this.fetch(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=${limit}&orderBy=created`,
      );
      if (!res.ok) return [];
      const parsed = IssueCommentsResponse.parse(await res.json());
      return parsed.comments.map((c) => ({
        id: c.id,
        author: c.author?.displayName ?? c.author?.emailAddress ?? "unknown",
        created: c.created ?? "",
        body: adfToPlainText(c.body).trim(),
      }));
    } catch {
      return [];
    }
  }

  /** Post a comment with an ADF body. Returns the comment id. */
  async postComment(key: string, body: AdfDocument): Promise<string> {
    const res = await this.fetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `jira postComment failed ${res.status}: ${redactSecrets(text.slice(0, 300))}`,
      );
    }
    return CommentResponse.parse(await res.json()).id;
  }

  /** Authenticated user. Cached per-token across calls within the process. */
  async getMyself(): Promise<JiraIdentity> {
    const cacheKey = cacheKeyForToken(this.creds.apiToken);
    const cached = _myselfCache.get(cacheKey);
    if (cached) return cached;
    const promise = (async () => {
      const res = await this.fetch(`/rest/api/3/myself`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `jira getMyself failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
        );
      }
      const parsed = MyselfResponse.parse(await res.json());
      return {
        accountId: parsed.accountId,
        displayName: parsed.displayName,
        emailAddress: parsed.emailAddress,
      };
    })();
    _myselfCache.set(cacheKey, promise);
    // On error, drop the cached failure so callers can retry.
    promise.catch(() => _myselfCache.delete(cacheKey));
    return promise;
  }

  async getIssueAssignee(key: string): Promise<{ accountId: string } | null> {
    const res = await this.fetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=assignee`,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `jira getIssueAssignee failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
      );
    }
    const parsed = IssueAssigneeResponse.parse(await res.json());
    if (!parsed.fields.assignee) return null;
    return { accountId: parsed.fields.assignee.accountId };
  }

  async assignIssue(key: string, accountId: string | null): Promise<void> {
    const res = await this.fetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`,
      { method: "PUT", body: JSON.stringify({ accountId }) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `jira assignIssue failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
      );
    }
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.fetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `jira getTransitions failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
      );
    }
    return TransitionsResponse.parse(await res.json()).transitions;
  }

  async transitionIssueToName(
    key: string,
    targetName: string,
  ): Promise<JiraTransition | null> {
    const transitions = await this.getTransitions(key);
    const target = targetName.toLowerCase().trim();
    const match = transitions.find(
      (t) =>
        t.name.toLowerCase() === target ||
        (t.to?.name ?? "").toLowerCase() === target,
    );
    if (!match) return null;
    const res = await this.fetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { method: "POST", body: JSON.stringify({ transition: { id: match.id } }) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `jira transitionIssue failed ${res.status}: ${redactSecrets(body.slice(0, 300))}`,
      );
    }
    return match;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function logRateLimit(res: Response, path: string): void {
  const near = res.headers.get("x-ratelimit-nearlimit");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reason = res.headers.get("x-ratelimit-reason");
  if (near === "true" || (remaining !== null && Number(remaining) < 50)) {
    // eslint-disable-next-line no-console
    console.warn("jira rate-limit warning", { path, remaining, near, reason });
  }
}

/**
 * Construct a JiraClient from the instance-default credentials in
 * settings. Returns null if the instance isn't configured. Used by
 * legacy free-function call sites that haven't been refactored to
 * accept a RunContext yet.
 */
export function makeInstanceJiraClient(): JiraClient | null {
  const resolved = resolveCredentials(null, "jira");
  if (resolved.source === "missing") return null;
  return new JiraClient({
    baseUrl: resolved.value.baseUrl,
    email: resolved.value.email,
    apiToken: String(resolved.value.apiToken),
  });
}

// ─── Legacy free functions (back-compat) ────────────────────────────────────
//
// These delegate to a JiraClient built from instance-default creds.
// Phase 3 of the per-user-tokens plan migrates remaining callers onto
// the class form; until then, these shims keep behaviour unchanged.

function instanceClientOrThrow(): JiraClient {
  const c = makeInstanceJiraClient();
  if (!c) throw new JiraNotConfiguredError();
  return c;
}

export async function searchJql(
  jql: string,
  fields?: string[],
  maxResults?: number,
): Promise<JiraIssueLite[]> {
  return instanceClientOrThrow().searchJql(jql, fields, maxResults);
}

export async function getIssue(key: string): Promise<JiraIssueLite | null> {
  return instanceClientOrThrow().getIssue(key);
}

export async function getIssueComments(
  key: string,
  limit = 50,
): Promise<JiraComment[]> {
  const c = makeInstanceJiraClient();
  if (!c) return []; // Quiet degrade — comments are non-load-bearing.
  return c.getIssueComments(key, limit);
}

export async function postComment(key: string, body: AdfDocument): Promise<string> {
  return instanceClientOrThrow().postComment(key, body);
}

export async function getMyself(): Promise<{ accountId: string }> {
  return instanceClientOrThrow().getMyself();
}

export async function getIssueAssignee(
  key: string,
): Promise<{ accountId: string } | null> {
  return instanceClientOrThrow().getIssueAssignee(key);
}

export async function assignIssue(
  key: string,
  accountId: string | null,
): Promise<void> {
  return instanceClientOrThrow().assignIssue(key, accountId);
}

export async function getTransitions(key: string): Promise<JiraTransition[]> {
  return instanceClientOrThrow().getTransitions(key);
}

export async function transitionIssueToName(
  key: string,
  targetName: string,
): Promise<JiraTransition | null> {
  return instanceClientOrThrow().transitionIssueToName(key, targetName);
}
