import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { desc, ne } from "drizzle-orm";
import { Board } from "@/components/board/Board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TeamBoardPage() {
  const rows = db
    .select({
      id: tasks.id,
      jiraKey: tasks.jiraKey,
      title: tasks.title,
      currentLane: tasks.currentLane,
      ownerId: tasks.ownerId,
    })
    .from(tasks)
    .where(ne(tasks.status, "archived"))
    .orderBy(desc(tasks.updatedAt))
    .all();

  return <Board initialTasks={rows} scope="all" />;
}
