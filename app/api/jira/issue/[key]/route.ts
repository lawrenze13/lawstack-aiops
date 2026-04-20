import { withAuth } from "@/server/lib/route";
import { getIssue } from "@/server/jira/client";
import { NotFound } from "@/server/lib/errors";

export const runtime = "nodejs";

export const GET = withAuth(async ({ req }) => {
  // Route param. Next 15 passes route segment via the URL since `withAuth`
  // doesn't pre-extract; parse from the path.
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const key = decodeURIComponent(segments[segments.length - 1] ?? "");
  const issue = await getIssue(key);
  if (!issue) throw new NotFound(`Jira issue ${key} not found`);
  return { issue };
});
