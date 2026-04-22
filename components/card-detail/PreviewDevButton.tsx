"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/toast/ToastHost";

type Props = {
  taskId: string;
  canControl: boolean;
};

/**
 * "Preview in dev" — swaps the local dev checkout to this task's branch
 * (POST /api/tasks/:id/preview) and opens PREVIEW_DEV_URL in a new tab.
 *
 * Single dev checkout → only one PR previewable at a time; this button
 * makes that the entire workflow: one click, branch + cache flipped,
 * new tab pops open on the running app.
 */
export function PreviewDevButton({ taskId, canControl }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canControl) return null;

  const run = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/preview`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        branch?: string;
        previewUrl?: string;
        message?: string;
      };
      if (!res.ok || !json.ok || !json.previewUrl) {
        const msg = json.message ?? `HTTP ${res.status}`;
        setError(msg);
        toast.push({ kind: "error", title: "Preview switch failed", body: msg });
        return;
      }
      toast.push({
        kind: "success",
        title: "Preview loaded",
        body: `dev env is now on ${json.branch}`,
      });
      // Cache-bust so php-fpm / browser serves fresh assets.
      const url = new URL(json.previewUrl);
      url.searchParams.set("_t", String(Date.now()));
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Checks out this task's branch in the local dev env and opens it in a new tab"
        className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2.5 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)] disabled:opacity-50"
      >
        {pending ? "Switching…" : "▶ Preview in dev"}
      </button>
      {error ? (
        <span className="text-[11px] text-red-700" title={error}>
          {error.length > 60 ? error.slice(0, 60) + "…" : error}
        </span>
      ) : null}
    </div>
  );
}
