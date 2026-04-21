import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { Board } from "@/components/board/Board";
import { enrichTask } from "@/server/lib/enrichTask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return null;

  const rows = db
    .select({
      id: tasks.id,
      jiraKey: tasks.jiraKey,
      title: tasks.title,
      currentLane: tasks.currentLane,
      ownerId: tasks.ownerId,
      currentRunId: tasks.currentRunId,
    })
    .from(tasks)
    .where(and(eq(tasks.ownerId, userId), ne(tasks.status, "archived")))
    .orderBy(desc(tasks.updatedAt))
    .all();

  return <Board initialTasks={rows.map(enrichTask)} scope="me" />;
}
