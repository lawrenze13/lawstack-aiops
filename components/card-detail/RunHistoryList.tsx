"use client";

import type { RunSummary } from "./RunLog";

type Props = {
  runs: RunSummary[];
};

/**
 * Chronological run history grouped by cycle. A cycle starts at every
 * brainstorm run; subsequent runs (plan, review, implement) belong to
 * the same cycle until the next brainstorm. Renders a visual divider
 * with a "Cycle N" header at each cycle boundary.
 *
 * Source data is the same `runs` array RunLog already receives — no new
 * DB query, no new endpoint. Pure transformation in the client.
 */
export function RunHistoryList({ runs }: Props) {
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);

  // Walk forward, grouping by cycle. A new "brainstorm" lane starts a
  // new cycle. Runs that come BEFORE the first brainstorm (rare —
  // shouldn't happen in normal flow but guard anyway) are bucketed
  // into "cycle 0" as a no-cycle group.
  type Group = { cycle: number; runs: RunSummary[] };
  const groups: Group[] = [];
  let currentCycle = 0;
  for (const r of sorted) {
    if (r.lane === "brainstorm") {
      currentCycle++;
      groups.push({ cycle: currentCycle, runs: [r] });
    } else {
      const last = groups[groups.length - 1];
      if (last) {
        last.runs.push(r);
      } else {
        groups.push({ cycle: 0, runs: [r] });
      }
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-[color:var(--muted)]">
        No runs yet.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-xs">
      {groups.map((g) => (
        <section key={`cycle-${g.cycle}`} className="mb-4">
          <header className="mb-1 flex items-center gap-2 border-b border-[color:var(--border)] pb-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              {g.cycle === 0 ? "Pre-cycle runs" : `Cycle ${g.cycle}`}
            </span>
            <span className="text-[10px] text-[color:var(--muted)]">
              · {g.runs.length} run{g.runs.length === 1 ? "" : "s"}
            </span>
          </header>
          <table className="w-full">
            <tbody>
              {g.runs.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[color:var(--border)]/40 last:border-b-0"
                >
                  <td className="py-1.5 pr-2 align-top">
                    <span className="font-mono text-[10px] text-[color:var(--muted)]">
                      {formatRelative(r.startedAt)}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 align-top">
                    <span className="rounded bg-[color:var(--surface-secondary)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]">
                      {r.lane}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 align-top font-mono text-[11px]">
                    {r.agentId}
                  </td>
                  <td className="py-1.5 pr-2 align-top">
                    <StatusChip status={r.status} />
                  </td>
                  <td className="py-1.5 pr-2 align-top text-right font-mono text-[10px] text-[color:var(--muted)]">
                    {r.numTurns} turn{r.numTurns === 1 ? "" : "s"}
                  </td>
                  <td className="py-1.5 align-top text-right font-mono text-[10px] text-[color:var(--muted)]">
                    {r.runnerType === "script" ? "" : `$${r.costUsd.toFixed(4)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case "completed":
        return "bg-blue-500/15 text-blue-700 border-blue-500/40";
      case "running":
      case "awaiting_input":
        return "bg-green-500/15 text-green-700 border-green-500/40";
      case "failed":
      case "cost_killed":
        return "bg-red-500/15 text-red-700 border-red-500/40";
      default:
        return "bg-amber-500/10 text-amber-800 border-amber-500/30";
    }
  })();
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${tone}`}
    >
      {status}
    </span>
  );
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(epochMs).toISOString().slice(0, 10);
}
