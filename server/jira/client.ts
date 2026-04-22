import "server-only";
import { z } from "zod";
import { env } from "@/server/lib/env";
import type { AdfDocument } from "./adf";

// Atlassian Jira Cloud REST v3 client.
// Auth: Basic with `email:api_token` base64'd. Rate-limit headers logged
// on every response — see plan section "External references" for header list.

class JiraNotConfiguredError extends Error {
  constructor() {
    super("Jira credentials are not configured (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN).");
  }
}

function authHeader(): string {
  if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
    throw new JiraNotConfiguredError();
  }
  const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

function logRateLimit(res: Response, path: string): void {
  const near = res.headers.get("x-ratelimit-nearlimit");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reason = res.headers.get("x-ratelimit-reason");
  if (near === "true" || (remaining !== null && Number(remaining) < 50)) {
    // eslint-disable-next-line no-console
    console.warn("jira rate-limit warning", { path, remaining, near, reason });
  }
}

async function jiraFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${env.JIRA_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  logRateLimit(res, path);
  return res;
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

// ─── Public surface ────────────────────────────────────────────────────────

/** Search via JQL. Uses the new /search/jql endpoint that replaced /search. */
export async function searchJql(
  jql: string,
  fields: string[] = ["summary", "status", "issuetype"],
  maxResults = 25,
): Promise<JiraIssueLite[]> {
  const params = new URLSearchParams({
    jql,
    fields: fields.join(","),
    maxResults: String(maxResults),
  });
  const res = await jiraFetch(`/rest/api/3/search/jql?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jira search failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const parsed = SearchResponse.parse(json);
  return parsed.issues;
}

/** Fetch a single issue by key (e.g., "MP-1050"). */
export async function getIssue(key: string): Promise<JiraIssueLite | null> {
  const res = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jira getIssue failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return JiraIssueLite.parse(json);
}

export type JiraComment = {
  id: string;
  author: string;
  created: string;
  /** Plain-text rendering of the ADF body. */
  body: string;
};

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

/**
 * Fetch comments on a Jira issue (oldest-first). Empty array if Jira isn't
 * configured or the call fails — comments are augmenting context, never
 * load-bearing, so we degrade quietly.
 */
export async function getIssueComments(
  key: string,
  limit = 50,
): Promise<JiraComment[]> {
  if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) return [];
  const { adfToPlainText } = await import("./adf");
  try {
    const res = await jiraFetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=${limit}&orderBy=created`,
    );
    if (!res.ok) return [];
    const json = await res.json();
    const parsed = IssueCommentsResponse.parse(json);
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

/** Post a comment with an ADF body. Returns the comment id (used for idempotency). */
export async function postComment(key: string, body: AdfDocument): Promise<string> {
  const res = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`jira postComment failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const parsed = CommentResponse.parse(await res.json());
  return parsed.id;
}

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

// Cached so repeated calls during a single run don't re-hit Jira.
let _myselfPromise: Promise<{ accountId: string }> | null = null;

/** Fetch the authenticated user (the JIRA_EMAIL/JIRA_API_TOKEN owner). */
export async function getMyself(): Promise<{ accountId: string }> {
  if (_myselfPromise) return _myselfPromise;
  _myselfPromise = (async () => {
    const res = await jiraFetch(`/rest/api/3/myself`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`jira getMyself failed ${res.status}: ${body.slice(0, 300)}`);
    }
    const parsed = MyselfResponse.parse(await res.json());
    return { accountId: parsed.accountId };
  })();
  return _myselfPromise;
}

/** Current assignee (null if unassigned). */
export async function getIssueAssignee(
  key: string,
): Promise<{ accountId: string } | null> {
  const res = await jiraFetch(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=assignee`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jira getIssueAssignee failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const parsed = IssueAssigneeResponse.parse(await res.json());
  if (!parsed.fields.assignee) return null;
  return { accountId: parsed.fields.assignee.accountId };
}

/** Assign an issue. `accountId=null` unassigns. */
export async function assignIssue(key: string, accountId: string | null): Promise<void> {
  const res = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jira assignIssue failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** List available transitions for an issue. Used to resolve a human-readable
 * target status name (e.g. "In Progress") to the transition id our workflow
 * actually uses. */
export async function getTransitions(key: string): Promise<JiraTransition[]> {
  const res = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jira getTransitions failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return TransitionsResponse.parse(await res.json()).transitions;
}

/** Transition an issue by human-readable status name. Matches target name
 * against available transitions' `name` and `to.name` (case-insensitive).
 * Returns the transition that ran, or null if the target isn't currently
 * available (e.g. the issue is already in that state, or the workflow
 * doesn't allow the move from the current state). */
export async function transitionIssueToName(
  key: string,
  targetName: string,
): Promise<JiraTransition | null> {
  const transitions = await getTransitions(key);
  const target = targetName.toLowerCase().trim();
  const match = transitions.find(
    (t) =>
      t.name.toLowerCase() === target ||
      (t.to?.name ?? "").toLowerCase() === target,
  );
  if (!match) return null;
  const res = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jira transitionIssue failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return match;
}

export { JiraNotConfiguredError };
