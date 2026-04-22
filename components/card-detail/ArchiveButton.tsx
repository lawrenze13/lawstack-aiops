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
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const archive = () => {
    setError(null);
    startTransition(async () => {
      const url = deleteRemote
        ? `/api/tasks/${taskId}?deleteRemote=1`
        : `/api/tasks/${taskId}`;
      const res = await fetch(url, { method: "DELETE" });
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
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs">
      <span className="text-red-800">
        Archive <span className="font-mono">{jiraKey}</span>? Worktree + local branch deleted; runs + messages kept for audit.
      </span>
      <label
        className="flex items-center gap-1 text-red-800"
        title="Also runs `gh pr close` and `git push origin --delete <branch>` on the remote"
      >
        <input
          type="checkbox"
          checked={deleteRemote}
          onChange={(e) => setDeleteRemote(e.target.checked)}
          disabled={pending}
          className="h-3 w-3"
        />
        <span>also delete remote branch + close PR</span>
      </label>
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
      {error ? <span className="w-full text-red-800">· {error}</span> : null}
    </div>
  );
}
