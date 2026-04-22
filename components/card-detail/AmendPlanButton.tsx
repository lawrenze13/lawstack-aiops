"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { useToast } from "@/components/toast/ToastHost";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  taskId: string;
  verdict: "READY" | "AMEND" | "REWRITE";
  canControl: boolean;
  /** True when the task has an in-flight run (any lane). Blocks Amend
   *  to avoid race between the active run and spawning an amend. */
  runActive: boolean;
};

/**
 * Shown in the card header when the latest Review artifact verdict is
 * AMEND or REWRITE. Clicking it spawns a new Plan run whose prompt
 * explicitly addresses every finding in the Review.
 *
 * Naturally cascades: the new Plan artifact marks the Review stale
 * (persistArtifacts.ts's downstream-stale rule), so the user re-runs
 * Review on the revised Plan and ideally lands on READY.
 */
export function AmendPlanButton({ taskId, verdict, canControl, runActive }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canControl) return null;
  if (verdict !== "AMEND" && verdict !== "REWRITE") return null;

  const isRewrite = verdict === "REWRITE";
  const label = isRewrite ? "Rewrite Plan from Review" : "Amend Plan from Review";
  const disabled = pending || runActive;
  // REWRITE = "destructive" (danger red) — the existing plan is being scrapped.
  // AMEND = "retry" (warning amber) — iterating on the existing plan.
  const intent = isRewrite ? "destructive" : "retry";

  const run = () => {
    setError(null);
    start(async () => {
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lane: "plan",
          agentId: "ce:plan",
          amendFromReview: true,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = j.message ?? `HTTP ${res.status}`;
        setError(msg);
        toast.push({ kind: "error", title: "Amend failed", body: msg });
        return;
      }
      toast.push({
        kind: "info",
        title: "Amending plan",
        body: "Re-running Plan with review findings baked in.",
      });
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        {...BUTTON_INTENTS[intent]}
        size="sm"
        onPress={run}
        isDisabled={disabled}
      >
        {pending ? "Running…" : runActive ? `⇡ ${label} (wait)` : `⇡ ${label}`}
      </Button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}
