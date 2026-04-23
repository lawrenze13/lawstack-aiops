import Link from "next/link";
import { activityFeed, type ViewerScope } from "@/server/lib/dashboardQueries";
import { TileShell } from "./OpsHealthTile";

function relTime(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function humanise(action: string): string {
  return action
    .replace(/^lane\.enter\./, "entered ")
    .replace(/^run\./, "run ")
    .replace(/^chat\./, "chat ")
    .replace(/_/g, " ");
}

export function ActivityFeedTile({ scope }: { scope: ViewerScope }) {
  let rows: ReturnType<typeof activityFeed>;
  try {
    rows = activityFeed(scope, 20);
  } catch (err) {
    return (
      <TileShell title="activity · recent" note="failed to load" tone="danger">
        <p className="text-xs text-red-600">{(err as Error).message}</p>
      </TileShell>
    );
  }

  if (rows.length === 0) {
    return (
      <TileShell title="activity · recent" note="empty">
        <p className="font-mono text-[11px] text-[color:var(--muted)]">
          Nothing to show yet. Run an agent from the board to populate.
        </p>
      </TileShell>
    );
  }

  return (
    <TileShell title="activity · recent" note={`last ${rows.length}`}>
      <ul className="max-h-[240px] divide-y divide-[color:var(--border)] overflow-y-auto">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-3 py-1.5 text-xs leading-tight"
          >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]/60" />
            <span className="truncate font-mono text-[11px] text-[color:var(--muted)]">
              {r.actor}
            </span>
            <span className="min-w-0 flex-1 truncate text-[color:var(--foreground)]">
              {humanise(r.action)}
              {r.taskId ? (
                <>
                  {" "}
                  on{" "}
                  <Link
                    href={`/cards/${r.taskId}`}
                    className="font-mono text-[color:var(--accent)] hover:underline"
                  >
                    {r.taskId.slice(0, 8)}
                  </Link>
                </>
              ) : null}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-[color:var(--muted)]">
              {relTime(r.ts)}
            </span>
          </li>
        ))}
      </ul>
    </TileShell>
  );
}
