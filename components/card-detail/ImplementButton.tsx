"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast/ToastHost";

type Props = {
  taskId: string;
  /** True when PR has been opened (approve pipeline reached pr_opened or jira_notified). */
  prOpened: boolean;
  /** True when an implement run has already been started on this task. */
  implementStarted: boolean;
  /** True when any run on this card is currently running (blocks spawn). */
  runActive: boolean;
  canControl: boolean;
};

/**
 * Starts a ce:work implementation run. Only shown after Approve & PR has
 * succeeded — the human should review the draft PR's planning docs
 * before agents start committing real code.
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
  // Once an implement run exists the button hides — card header shows
  // the run directly via the runs sidebar.
  if (implementStarted) return null;

  const disabled = pending || runActive;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setErr(null);
          start(async () => {
            const res = await fetch(`/api/tasks/${taskId}/runs`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ lane: "implement", agentId: "ce:work" }),
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
              title: "Implementation started",
              body: "ce:work will commit + push incrementally.",
            });
            router.refresh();
          });
        }}
        className={`rounded-md px-3 py-1.5 text-xs font-semibold shadow-sm ${
          disabled
            ? "bg-[color:var(--color-muted)] text-[color:var(--color-muted-foreground)] cursor-not-allowed"
            : "bg-indigo-600 text-white hover:bg-indigo-700"
        }`}
        title={
          runActive
            ? "A run is active on this card — wait for it to finish or click Stop first."
            : "Start ce:work to implement the approved plan. Agent will commit + push to the feature branch and pause with NEEDS_INPUT when it needs clarification."
        }
      >
        {pending ? "Starting…" : runActive ? "▶ Implement (wait)" : "▶ Implement"}
      </button>
      {err ? <span className="text-xs text-red-700">{err}</span> : null}
    </div>
  );
}
