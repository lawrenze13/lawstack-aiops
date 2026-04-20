import { z } from "zod";
import { withAuth } from "@/server/lib/route";
import { searchJql } from "@/server/jira/client";
import { BadRequest } from "@/server/lib/errors";

export const runtime = "nodejs";

const Q = z.object({
  q: z.string().min(1).max(200),
});

export const GET = withAuth(async ({ req }) => {
  const url = new URL(req.url);
  const { q } = Q.parse(Object.fromEntries(url.searchParams));

  // If the input looks like a Jira key (PROJECT-123), search by key directly.
  // Otherwise treat as text and search summary.
  const keyMatch = /^[A-Z][A-Z0-9]+-\d+$/.test(q.trim());
  const jql = keyMatch
    ? `key = "${q.trim()}"`
    : `(summary ~ "${q.replace(/"/g, '\\"')}" OR text ~ "${q.replace(/"/g, '\\"')}") ORDER BY updated DESC`;

  try {
    const issues = await searchJql(jql, ["summary", "status", "issuetype"], 20);
    return { issues };
  } catch (err) {
    throw new BadRequest((err as Error).message);
  }
});
