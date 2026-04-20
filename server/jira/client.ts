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

export { JiraNotConfiguredError };
