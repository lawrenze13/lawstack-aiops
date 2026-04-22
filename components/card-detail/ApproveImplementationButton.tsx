"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast/ToastHost";

type Props = {
  taskId: string;
  canControl: boolean;
  /** True after implementComplete succeeded (lane has moved to 'done'). */
  alreadyFinalised: boolean;
};

/**
 * Shown on the card once the ce:work agent finishes an implement run with
 * status='completed'. The run leaves uncommitted changes in the worktree;
 * clicking this button triggers the server-side 5-step finalisation
 * (commit + push + Jira comment + status transition + lane to done).
 */
export function ApproveImplementationButton({
  taskId,
  canControl,
  alreadyFinalised,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canControl) return null;

  if (alreadyFinalised) {
    return (
      <span
        className="rounded-md border border-green-500/40 bg-green-500/10 px-3 py-1 text-xs font-medium text-green-800"
        title="Implementation committed, pushed, and Jira updated"
      >
        ✓ Implementation finalised
      </span>
    );
  }

  const run = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/approve-implementation`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        failedAt?: string;
        error?: string;
        message?: string;
        pushed?: boolean;
        commitsPosted?: number;
        transitioned?: boolean;
        warnings?: string[];
        alreadyApproved?: boolean;
      };
      if (!res.ok) {
        const msg = json.message ?? `HTTP ${res.status}`;
        setError(msg);
        toast.push({ kind: "error", title: "Approve failed", body: msg });
        router.refresh();
        return;
      }
      if (json.ok === false) {
        const msg = `failed at ${json.failedAt}: ${json.error}`;
        setError(msg);
        toast.push({ kind: "error", title: "Approve failed", body: msg });
        router.refresh();
        return;
      }
      if (json.alreadyApproved) {
        toast.push({ kind: "info", title: "Already finalised" });
        router.refresh();
        return;
      }
      const bodyParts: string[] = [];
      if (json.commitsPosted) bodyParts.push(`${json.commitsPosted} commit(s)`);
      if (json.transitioned) bodyParts.push("Jira → Code Review");
      toast.push({
        kind: "success",
        title: "Implementation finalised",
        body: bodyParts.join(" · ") || undefined,
      });
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={run}
        className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-[color:var(--color-muted)] disabled:text-[color:var(--color-muted-foreground)]"
        title="Commit + push the agent's changes, comment on Jira, transition to Code Review, move lane to Done"
      >
        {pending ? "Finalising…" : "✓ Approve Implementation"}
      </button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}
