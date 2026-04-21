"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast/ToastHost";

type Props = {
  taskId: string;
  prOpened: boolean;
  implementStarted: boolean;
  runActive: boolean;
  canControl: boolean;
};

/**
 * Starts a ce:work implementation run. Only shown after Approve & PR
 * has succeeded. Two modes:
 *
 *   - **Interactive** (default) — agent pauses via NEEDS_INPUT before
 *     every Bash command and waits for the user to approve via chat.
 *     Slower but user is in the loop for every shell action.
 *
 *   - **Autopilot** — agent runs everything without confirmation. Use
 *     when you trust the plan + review and want throughput.
 */
export function ImplementButton({
  taskId,
  prOpened,
  implementStarted,
  runActive,
  canControl,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  if (!canControl) return null;
  if (!prOpened) return null;
  if (implementStarted) return null;

  const disabled = pending || runActive;

  const runImplement = (interactive: boolean) => {
    setErr(null);
    start(async () => {
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lane: "implement",
          agentId: "ce:work",
          interactive,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = j.message ?? `HTTP ${res.status}`;
        setErr(msg);
        toast.push({ kind: "error", title: "Implement failed", body: msg });
        return;
      }
      toast.push({
        kind: "info",
        title: interactive ? "Interactive implement started" : "Autopilot implement started",
        body: interactive
          ? "Agent will pause via chat before each Bash command."
          : "Agent runs on its own; commits push automatically.",
      });
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => runImplement(true)}
        className={`rounded-md px-3 py-1.5 text-xs font-semibold shadow-sm ${
          disabled
            ? "bg-[color:var(--color-muted)] text-[color:var(--color-muted-foreground)] cursor-not-allowed"
            : "bg-indigo-600 text-white hover:bg-indigo-700"
        }`}
        title={
          runActive
            ? "A run is active — wait or Stop first."
            : "Interactive: agent pauses via chat before each Bash command. You approve/deny each shell action."
        }
      >
        {pending ? "Starting…" : runActive ? "▶ Implement (wait)" : "▶ Implement · Interactive"}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => runImplement(false)}
        className={`rounded-md border px-2.5 py-1.5 text-xs ${
          disabled
            ? "border-[color:var(--color-border)] text-[color:var(--color-muted-foreground)] cursor-not-allowed"
            : "border-[color:var(--color-border)] text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]"
        }`}
        title="Autopilot: agent runs without confirming each shell command. Faster but hands-off."
      >
        ⚡ Autopilot
      </button>
      {err ? <span className="text-xs text-red-700">{err}</span> : null}
    </div>
  );
}
