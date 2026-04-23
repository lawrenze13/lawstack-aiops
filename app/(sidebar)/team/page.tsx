import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { desc, ne } from "drizzle-orm";
import { Board } from "@/components/board/Board";
import { enrichTask } from "@/server/lib/enrichTask";
import { SettingsDriftBanner } from "@/components/admin/SettingsDriftBanner";
import { MaintenanceGate } from "@/components/admin/MaintenanceGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TeamBoardPage() {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;

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
  return (
    <MaintenanceGate role={role}>
      <SettingsDriftBanner role={role} />
      <Board initialTasks={enriched} scope="all" />
    </MaintenanceGate>
  );
}
