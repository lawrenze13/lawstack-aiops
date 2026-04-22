"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { TextArea } from "@heroui/react/textarea";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

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
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        onPress={() => setOpen((v) => !v)}
        isDisabled={runActive}
      >
        {open ? "× Cancel" : "+ New Run"}
      </Button>

      {open ? (
        <div className="mt-2 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/30 p-2">
          <label className="mb-2 flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-[color:var(--muted)]">
              Agent
            </span>
            <select
              value={agentId}
              onChange={(e) => pickAgent(e.target.value)}
              className="rounded border border-[color:var(--border)] bg-[color:var(--surface)] px-2 py-1 text-xs"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
            </select>
          </label>

          <label className="mb-2 flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-[color:var(--muted)]">
              Lane
            </span>
            <select
              value={lane}
              onChange={(e) => setLane(e.target.value as typeof lane)}
              className="rounded border border-[color:var(--border)] bg-[color:var(--surface)] px-2 py-1 text-xs"
            >
              {(selected?.lanes ?? []).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-2 flex flex-col gap-1 text-[11px]">
            <span className="font-medium text-[color:var(--muted)]">
              Extra prompt (optional)
            </span>
            <TextArea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder={"e.g. “focus on the migration files only” or “skip the styling pass”"}
              className="text-xs"
            />
            <span className="text-[10px] text-[color:var(--muted)]">
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
            <Button
              {...BUTTON_INTENTS["neutral-secondary"]}
              size="sm"
              onPress={() => setOpen(false)}
              isDisabled={pending}
            >
              Cancel
            </Button>
            <Button
              {...BUTTON_INTENTS["primary-action"]}
              size="sm"
              onPress={submit}
              isDisabled={pending || !agentId || !lane}
            >
              {pending ? "Starting…" : "Start run"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
