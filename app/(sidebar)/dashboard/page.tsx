import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { OpsHealthTile } from "@/components/dashboard/OpsHealthTile";
import { CostMeterTile } from "@/components/dashboard/CostMeterTile";
import { ThroughputTile } from "@/components/dashboard/ThroughputTile";
import { ActivityFeedTile } from "@/components/dashboard/ActivityFeedTile";
import { AutoRefresh } from "../admin/ops/AutoRefresh";
import type { ViewerScope } from "@/server/lib/dashboardQueries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  const user = session?.user as
    | { id?: string; role?: string }
    | undefined;
  if (!user?.id) redirect("/sign-in");

  const role = (user.role ?? "member") as "admin" | "member" | "viewer";
  const scope: ViewerScope = { userId: user.id, role };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            dashboard · {role === "admin" ? "all users" : "you"}
          </div>
          <h1 className="text-xl font-semibold">Control room</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            Live status across every run, today&rsquo;s spend, where tickets
            are stacking up, and what just happened.
          </p>
        </div>
        <AutoRefresh intervalMs={15_000} />
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <OpsHealthTile scope={scope} />
        <CostMeterTile scope={scope} />
        <ThroughputTile scope={scope} />
        <ActivityFeedTile scope={scope} />
      </div>
    </div>
  );
}
