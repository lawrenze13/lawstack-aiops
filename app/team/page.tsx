import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { desc, ne } from "drizzle-orm";
import { Board } from "@/components/board/Board";
import { enrichTask } from "@/server/lib/enrichTask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TeamBoardPage() {
  const session = await auth();
  const isAdmin =
    (session?.user as { role?: string } | undefined)?.role === "admin";

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
    .where(ne(tasks.status, "archived"))
    .orderBy(desc(tasks.updatedAt))
    .all();

  const enriched = rows.map((t) => enrichTask(t));
  return <Board initialTasks={enriched} scope="all" isAdmin={isAdmin} />;
}
