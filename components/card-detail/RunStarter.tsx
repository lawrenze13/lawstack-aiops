"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type LaneOption = {
  lane: "brainstorm" | "plan" | "review";
  agentId: string;
  label: string;
};

type Props = {
  taskId: string;
  /** Lanes the user can run from this card. */
  options: LaneOption[];
};

export function RunStarter({ taskId, options }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showSingle, setShowSingle] = useState(false);

  const startLane = (lane: LaneOption["lane"], agentId: string) => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lane, agentId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `failed: HTTP ${res.status}`);
        return;
      }
      router.refresh();
    });
  };

  // "Start Automation" launches the first lane (brainstorm); auto-advance
  // carries it through Plan → Review. The PR lane is not agent-driven.
  const startAutomation = options.find((o) => o.lane === "brainstorm");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {startAutomation ? (
          <button
            type="button"
            onClick={() => startLane(startAutomation.lane, startAutomation.agentId)}
            disabled={pending}
            className="rounded-md bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-semibold text-[color:var(--color-background)] shadow-sm hover:opacity-90 disabled:opacity-50"
            title="Runs Brainstorm → auto-advances to Plan → Review, stops at Approve & PR gate"
          >
            {pending ? "Starting…" : "▶ Start Automation"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setShowSingle((v) => !v)}
          className="text-xs text-[color:var(--color-muted-foreground)] underline-offset-2 hover:underline"
        >
          {showSingle ? "Hide single-step runs" : "Run a single stage instead"}
        </button>

        {error ? <span className="text-xs text-red-700">{error}</span> : null}
      </div>

      {showSingle ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-3 py-2">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Single stage (no auto-advance to next lane):
          </span>
          {options.map((o) => (
            <button
              key={`${o.lane}:${o.agentId}`}
              type="button"
              onClick={() => startLane(o.lane, o.agentId)}
              disabled={pending}
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2.5 py-1 text-xs hover:bg-[color:var(--color-muted)] disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
