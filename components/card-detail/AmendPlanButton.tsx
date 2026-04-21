"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast/ToastHost";

type Props = {
  taskId: string;
  verdict: "READY" | "AMEND" | "REWRITE";
  canControl: boolean;
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
export function AmendPlanButton({ taskId, verdict, canControl }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canControl) return null;
  if (verdict !== "AMEND" && verdict !== "REWRITE") return null;

  const isRewrite = verdict === "REWRITE";
  const label = isRewrite ? "Rewrite Plan from Review" : "Amend Plan from Review";
  const tone = isRewrite
    ? "bg-red-600 hover:bg-red-700"
    : "bg-amber-500 hover:bg-amber-600";

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
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm disabled:opacity-50 ${tone}`}
        title={
          isRewrite
            ? "Review flagged fundamental issues — regenerate Plan from scratch using the review findings."
            : "Review flagged specific issues — re-run Plan to address them."
        }
      >
        {pending ? "Running…" : `⇡ ${label}`}
      </button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}
