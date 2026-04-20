"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  taskId: string;
  jiraKey: string;
};

export function ArchiveButton({ taskId, jiraKey }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const archive = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      router.push("/");
      router.refresh();
    });
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-[color:var(--color-border)] px-2.5 py-1 text-xs text-[color:var(--color-muted-foreground)] hover:border-red-500/40 hover:text-red-700"
        title="Archive this task and remove its worktree from disk"
      >
        Archive
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs">
      <span className="text-red-800">
        Archive <span className="font-mono">{jiraKey}</span>? Worktree will be deleted; runs + messages kept for audit.
      </span>
      <button
        type="button"
        onClick={archive}
        disabled={pending}
        className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {pending ? "Archiving…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="text-red-800 underline-offset-2 hover:underline disabled:opacity-50"
      >
        cancel
      </button>
      {error ? <span className="text-red-800">· {error}</span> : null}
    </div>
  );
}
