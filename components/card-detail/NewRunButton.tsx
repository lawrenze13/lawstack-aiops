"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type NewRunAgentOption = {
  id: string;
  name: string;
  lanes: Array<"brainstorm" | "plan" | "review" | "implement">;
};

type Props = {
  taskId: string;
  /** Disable when another run is live — can't have two concurrent runs on one task. */
  runActive: boolean;
  /** Everything that can be dispatched from here. */
  agents: NewRunAgentOption[];
};

/**
 * "+ New Run" in the Runs panel header. Opens an inline panel where the
 * user picks an agent + lane + optional extra prompt, then POSTs to
 * `/api/tasks/:id/runs`. Disabled while any run is live so two
 * subprocesses never contend for the same worktree.
 */
export function NewRunButton({ taskId, runActive, agents }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? "");
  const selected = agents.find((a) => a.id === agentId) ?? agents[0];
  const [lane, setLane] = useState<NewRunAgentOption["lanes"][number]>(
    selected?.lanes[0] ?? "brainstorm",
  );
  const [extra, setExtra] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pickAgent = (id: string) => {
    setAgentId(id);
    const a = agents.find((x) => x.id === id);
    if (a && !a.lanes.includes(lane)) setLane(a.lanes[0]!);
  };

  const submit = () => {
    if (!agentId || !lane) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          lane,
          additionalPrompt: extra.trim() || undefined,
          interactive: lane === "implement" ? interactive : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(json.message ?? `HTTP ${res.status}`);
        return;
      }
      setOpen(false);
      setExtra("");
      router.refresh();
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={runActive}
        title={
          runActive
            ? "A run is currently active — wait for it to finish or Stop it first."
            : "Start a fresh run with a chosen agent + optional extra prompt."
        }
        className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-0.5 text-[11px] font-medium hover:bg-[color:var(--color-muted)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? "× Cancel" : "+ New Run"}
      </button>

      {open ? (
        <div className="mt-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 p-2">
          <label className="mb-2 flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-[color:var(--color-muted-foreground)]">
              Agent
            </span>
            <select
              value={agentId}
              onChange={(e) => pickAgent(e.target.value)}
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-1 text-xs"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
            </select>
          </label>

          <label className="mb-2 flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-[color:var(--color-muted-foreground)]">
              Lane
            </span>
            <select
              value={lane}
              onChange={(e) => setLane(e.target.value as typeof lane)}
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-1 text-xs"
            >
              {(selected?.lanes ?? []).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-2 flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-[color:var(--color-muted-foreground)]">
              Extra prompt (optional)
            </span>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder={"e.g. “focus on the migration files only” or “skip the styling pass”"}
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-1 text-xs placeholder:text-[color:var(--color-muted-foreground)]"
            />
            <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
              Appended to the agent's built-in prompt. Leave empty for default behaviour.
            </span>
          </label>

          {lane === "implement" ? (
            <label className="mb-2 flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={interactive}
                onChange={(e) => setInteractive(e.target.checked)}
                className="h-3 w-3"
              />
              <span>Interactive mode (agent pauses before each Bash)</span>
            </label>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-2">
            {error ? (
              <span className="mr-auto text-[11px] text-red-700" title={error}>
                {error.length > 60 ? error.slice(0, 60) + "…" : error}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="rounded border border-[color:var(--color-border)] px-2 py-1 text-[11px] hover:bg-[color:var(--color-muted)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !agentId || !lane}
              className="rounded bg-[color:var(--color-foreground)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Starting…" : "Start run"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
