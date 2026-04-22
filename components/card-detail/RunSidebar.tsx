"use client";

import { NewRunButton, type NewRunAgentOption } from "./NewRunButton";

export type RunSummary = {
  id: string;
  lane: string;
  agentId: string;
  status: string;
  costUsd: number;
  numTurns: number;
  startedAt: number;
};

type Props = {
  runs: RunSummary[];
  currentRunId: string | null;
  /** Used by the "+ New Run" button — gated on this + runActive. */
  taskId: string;
  /** True when any run for this task is running/awaiting_input. */
  runActive: boolean;
  /** Agents the operator can dispatch from here. */
  agents: NewRunAgentOption[];
};

/**
 * Sidebar list of every run on this card. Clicking a run scrolls the thread
 * log to the anchor `#run-<runId>` (set by the in-log per-run header). The
 * scroll is smooth and uses the native anchor behavior — no JS beyond the
 * href so it keeps working if the client bundle is slow.
 */
export function RunSidebar({
  runs,
  currentRunId,
  taskId,
  runActive,
  agents,
}: Props) {
  return (
    <div className="flex-1 overflow-y-auto rounded-lg border border-[color:var(--color-border)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Runs</h2>
          <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
            {runs.length}
          </span>
        </div>
        <NewRunButton taskId={taskId} runActive={runActive} agents={agents} />
      </div>

      {runs.length === 0 ? (
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          No runs yet. Click a button above to start one.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r, i) => (
            <li key={r.id}>
              <a
                href={`#run-${r.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const target = document.getElementById(`run-${r.id}`);
                  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={`block rounded border px-2 py-1.5 text-xs hover:border-blue-500/40 hover:bg-blue-500/5 ${
                  currentRunId === r.id
                    ? "border-blue-500/40 bg-blue-500/5"
                    : "border-[color:var(--color-border)]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-medium">
                    {i + 1}. {r.lane}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  {r.agentId} · {r.numTurns} turn{r.numTurns === 1 ? "" : "s"} · $
                  {r.costUsd.toFixed(4)}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "running"
      ? "bg-green-500/15 text-green-700 border-green-500/40"
      : status === "completed"
        ? "bg-blue-500/10 text-blue-700 border-blue-500/30"
        : status === "failed" || status === "cost_killed"
          ? "bg-red-500/15 text-red-700 border-red-500/40"
          : status === "stopped" || status === "interrupted"
            ? "bg-amber-500/15 text-amber-800 border-amber-500/40"
            : "bg-[color:var(--color-muted)] text-[color:var(--color-muted-foreground)] border-[color:var(--color-border)]";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase ${cls}`}>
      {status}
    </span>
  );
}
