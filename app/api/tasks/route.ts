import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, and, ne, desc } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { getIssue } from "@/server/jira/client";
import { adfToPlainText } from "@/server/jira/adf";
import { audit } from "@/server/auth/audit";
import { BadRequest, Conflict, NotFound } from "@/server/lib/errors";

export const runtime = "nodejs";

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

const CreateBody = z.object({
  jiraKey: z.string().regex(KEY_RE, "expected JIRA key like PROJECT-123"),
});

export const POST = withAuth(async ({ req, user }) => {
  const body = CreateBody.parse(await req.json());
  const jiraKey = body.jiraKey.toUpperCase();

  // Dedup: surface existing active task for the same key.
  const existing = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.jiraKey, jiraKey), ne(tasks.status, "archived")))
    .limit(1)
    .all();
  if (existing.length > 0) {
    throw new Conflict(`task already exists for ${jiraKey}: ${existing[0]!.id}`);
  }

  // Fetch from Jira; degrade gracefully if Jira is unreachable.
  let title = jiraKey;
  let descriptionMd = "";
  let jiraSynced = true;
  try {
    const issue = await getIssue(jiraKey);
    if (!issue) throw new NotFound(`Jira issue ${jiraKey} not found`);
    title = issue.fields.summary;
    descriptionMd = adfToPlainText(issue.fields.description).trim();
  } catch (err) {
    if (err instanceof NotFound) throw err;
    jiraSynced = false;
    // eslint-disable-next-line no-console
    console.warn("jira fetch failed during task creation; degrading", { jiraKey, err });
  }

  const id = randomUUID();
  try {
    db.insert(tasks)
      .values({
        id,
        jiraKey,
        title,
        descriptionMd,
        ownerId: user.id,
        status: "active",
        currentLane: "ticket",
        jiraSynced,
      })
      .run();
  } catch (err) {
    // Race on the unique-index. Re-fetch and surface existing.
    const again = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.jiraKey, jiraKey), ne(tasks.status, "archived")))
      .limit(1)
      .all();
    if (again.length > 0) throw new Conflict(`task already exists for ${jiraKey}: ${again[0]!.id}`);
    throw new BadRequest(`failed to create task: ${(err as Error).message}`);
  }

  audit({ action: "task.created", actorUserId: user.id, taskId: id, payload: { jiraKey, title } });

  const created = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return { task: created };
});

const ListQ = z.object({
  scope: z.enum(["me", "all"]).default("me"),
});

export const GET = withAuth(async ({ req, user }) => {
  const url = new URL(req.url);
  const { scope } = ListQ.parse(Object.fromEntries(url.searchParams));

  const where =
    scope === "me"
      ? and(eq(tasks.ownerId, user.id), ne(tasks.status, "archived"))
      : ne(tasks.status, "archived");

  const rows = db.select().from(tasks).where(where).orderBy(desc(tasks.updatedAt)).all();
  return { tasks: rows };
});
