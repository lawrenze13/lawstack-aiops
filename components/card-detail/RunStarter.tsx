"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  taskId: string;
  /** lanes the user can run from this card right now */
  options: Array<{ lane: "brainstorm" | "plan" | "review"; agentId: string; label: string }>;
};

export function RunStarter({ taskId, options }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const start = (lane: Props["options"][number]["lane"], agentId: string) => {
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((o) => (
        <button
          key={`${o.lane}:${o.agentId}`}
          type="button"
          onClick={() => start(o.lane, o.agentId)}
          disabled={pending}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)] disabled:opacity-50"
        >
          {pending ? "Starting…" : o.label}
        </button>
      ))}
      {error ? (
        <span className="text-xs text-red-700">{error}</span>
      ) : null}
    </div>
  );
}
