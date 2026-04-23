import {
  throughputByLane,
  type ViewerScope,
} from "@/server/lib/dashboardQueries";
import { TileShell } from "./OpsHealthTile";

/**
 * Stacked sparkline per lane for the last 7 days. Hand-rolled SVG
 * so we avoid a charting dependency; each lane is one <path> polyline.
 */
export function ThroughputTile({ scope }: { scope: ViewerScope }) {
  let data: ReturnType<typeof throughputByLane>;
  try {
    data = throughputByLane(scope);
  } catch (err) {
    return (
      <TileShell title="throughput · 7d" note="failed to load" tone="danger">
        <p className="text-xs text-red-600">{(err as Error).message}</p>
      </TileShell>
    );
  }

  const { byLane, total, lanes } = data;

  if (total === 0) {
    return (
      <TileShell title="throughput · 7d" note="0 transitions">
        <p className="font-mono text-[11px] text-[color:var(--muted)]">
          No lane transitions in the last 7 days.
        </p>
      </TileShell>
    );
  }

  const maxPerLane = Math.max(
    1,
    ...lanes.map((l) => Math.max(...byLane[l])),
  );

  return (
    <TileShell title="throughput · 7d" note={`${total} transitions`}>
      <div className="space-y-1">
        {lanes.map((lane) => {
          const series = byLane[lane];
          const laneTotal = series.reduce((s, n) => s + n, 0);
          return (
            <div key={lane} className="flex items-center gap-3">
              <span className="w-20 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
                {lane}
              </span>
              <Spark data={series} max={maxPerLane} />
              <span className="w-6 text-right font-mono text-[10px] text-[color:var(--muted)]">
                {laneTotal}
              </span>
            </div>
          );
        })}
      </div>
    </TileShell>
  );
}

function Spark({ data, max }: { data: number[]; max: number }) {
  const w = 120;
  const h = 18;
  const step = w / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      className="flex-1"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
