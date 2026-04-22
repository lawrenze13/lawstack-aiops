"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

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
          <Button
            {...BUTTON_INTENTS["primary-action"]}
            size="md"
            isDisabled={pending}
            onPress={() => startLane(startAutomation.lane, startAutomation.agentId)}
          >
            {pending ? "Starting…" : "▶ Start Automation"}
          </Button>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          onPress={() => setShowSingle((v) => !v)}
        >
          {showSingle ? "Hide single-step runs" : "Run a single stage instead"}
        </Button>

        {error ? <span className="text-xs text-red-700">{error}</span> : null}
      </div>

      {showSingle ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[color:var(--border)] bg-[color:var(--surface-secondary)]/30 px-3 py-2">
          <span className="text-xs text-[color:var(--muted)]">
            Single stage (no auto-advance to next lane):
          </span>
          {options.map((o) => (
            <Button
              key={`${o.lane}:${o.agentId}`}
              {...BUTTON_INTENTS["neutral-secondary"]}
              size="sm"
              isDisabled={pending}
              onPress={() => startLane(o.lane, o.agentId)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
