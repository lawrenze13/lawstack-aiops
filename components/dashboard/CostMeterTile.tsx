import { costMeter, type ViewerScope } from "@/server/lib/dashboardQueries";
import { TileShell } from "./OpsHealthTile";

function fmt(usd: number): string {
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

export function CostMeterTile({ scope }: { scope: ViewerScope }) {
  let data: ReturnType<typeof costMeter>;
  try {
    data = costMeter(scope);
  } catch (err) {
    return (
      <TileShell title="cost · agents" note="failed to load" tone="danger">
        <p className="text-xs text-red-600">{(err as Error).message}</p>
      </TileShell>
    );
  }

  const { today, week, topAgents } = data;

  return (
    <TileShell title="cost · agents" note={scope.role === "admin" ? "all users" : "you"}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            today
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold text-[color:var(--foreground)]">
            {fmt(today)}
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            last 7 days
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold text-[color:var(--foreground)]">
            {fmt(week)}
          </div>
        </div>
      </div>

      {topAgents.length > 0 ? (
        <div className="mt-4 border-t border-[color:var(--border)] pt-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            top agents (7d)
          </div>
          <ul className="space-y-1.5">
            {topAgents.map((a) => {
              const pct = week > 0 ? Math.round((a.usd / week) * 100) : 0;
              return (
                <li key={a.agentId} className="flex items-center gap-3 text-xs">
                  <span className="min-w-[100px] font-mono text-[color:var(--foreground)]">
                    {a.agentId}
                  </span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--surface-secondary)]">
                    <div
                      className="absolute inset-y-0 left-0 bg-[color:var(--accent)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-14 text-right font-mono text-[color:var(--muted)]">
                    {fmt(a.usd)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 font-mono text-[11px] text-[color:var(--muted)]">
          No runs this week.
        </p>
      )}
    </TileShell>
  );
}
