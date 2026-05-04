"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { useToast } from "@/components/toast/ToastHost";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  taskId: string;
  canControl: boolean;
};

type PreviewResponse = {
  ok?: boolean;
  branch?: string;
  previewUrl?: string;
  message?: string;
  /** Set on 409 DirtyTreeConflict — count of tracked changes that
   *  would be discarded on a force-switch. File PATHS are NOT exposed
   *  to the client (they live in the audit row server-side). */
  dirtyCount?: number;
};

/**
 * "Preview in dev" — swaps the local dev checkout to this task's branch
 * (POST /api/tasks/:id/preview) and opens PREVIEW_DEV_URL in a new tab.
 *
 * Two modes:
 *
 *   - Default: refuses to switch when the dev dir has uncommitted
 *     tracked changes (server returns 409 DirtyTreeConflict with a
 *     `dirtyCount`). The button transitions to a force-confirm prompt.
 *   - Force: with operator confirmation, retries with `{force: true}`.
 *     The server captures the dirty changes via `git stash create`
 *     (recoverable via `git reflog` for ~14 days) before running
 *     `git checkout -f`.
 */
export function PreviewDevButton({ taskId, canControl }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** When set, the button enters force-confirm mode. */
  const [pendingForce, setPendingForce] = useState<{ dirtyCount: number } | null>(null);

  if (!canControl) return null;

  const doSwitch = (force: boolean) => {
    setError(null);
    if (!force) setPendingForce(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const json = (await res.json().catch(() => ({}))) as PreviewResponse;

      if (!res.ok) {
        // DirtyTreeConflict — surface the force-confirm UI.
        if (
          res.status === 409 &&
          typeof json.dirtyCount === "number" &&
          json.dirtyCount > 0
        ) {
          setPendingForce({ dirtyCount: json.dirtyCount });
          return;
        }
        const msg = json.message ?? `HTTP ${res.status}`;
        setError(msg);
        toast.push({ kind: "error", title: "Preview switch failed", body: msg });
        return;
      }

      if (!json.ok || !json.previewUrl) {
        const msg = json.message ?? "preview switch returned an unexpected response";
        setError(msg);
        toast.push({ kind: "error", title: "Preview switch failed", body: msg });
        return;
      }

      setPendingForce(null);
      toast.push({
        kind: force ? "warn" : "success",
        title: force ? "Preview switched (force)" : "Preview loaded",
        body: force
          ? `dev env is now on ${json.branch} (prior changes stashed)`
          : `dev env is now on ${json.branch}`,
      });
      // Cache-bust so php-fpm / browser serves fresh assets.
      const url = new URL(json.previewUrl);
      url.searchParams.set("_t", String(Date.now()));
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    });
  };

  // Force-confirm prompt. Shows the count (not the file paths — those
  // are recorded in the audit row server-side per security review H3).
  if (pendingForce) {
    const n = pendingForce.dirtyCount;
    return (
      <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px]">
        <span className="text-amber-900">
          ⚠ Preview dev has {n} uncommitted change{n === 1 ? "" : "s"}.
          Discard and switch?
        </span>
        <Button
          {...BUTTON_INTENTS["destructive"]}
          size="sm"
          isDisabled={pending}
          onPress={() => doSwitch(true)}
        >
          {pending ? "Switching…" : "Discard & switch"}
        </Button>
        <button
          type="button"
          onClick={() => setPendingForce(null)}
          disabled={pending}
          className="text-[11px] text-[color:var(--muted)] underline-offset-2 hover:text-[color:var(--foreground)] hover:underline disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        isDisabled={pending}
        onPress={() => doSwitch(false)}
      >
        {pending ? "Switching…" : "▶ Preview in dev"}
      </Button>
      {error ? (
        <span className="text-[11px] text-red-700" title={error}>
          {error.length > 60 ? error.slice(0, 60) + "…" : error}
        </span>
      ) : null}
    </div>
  );
}
