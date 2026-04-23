import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { Board } from "@/components/board/Board";
import { enrichTask } from "@/server/lib/enrichTask";
import { SettingsDriftBanner } from "@/components/admin/SettingsDriftBanner";
import { MaintenanceGate } from "@/components/admin/MaintenanceGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  const user = session?.user as { id?: string; role?: string } | undefined;
  const userId = user?.id;
  if (!userId) return null;
  const role = user?.role;

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

  return (
    <MaintenanceGate role={role}>
      <SettingsDriftBanner role={role} />
      <Board initialTasks={rows.map(enrichTask)} scope="me" />
    </MaintenanceGate>
  );
}
