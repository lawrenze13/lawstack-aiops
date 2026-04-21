"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function KillRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setErr(null);
        start(async () => {
          const res = await fetch("/api/admin/kill-run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId }),
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { message?: string };
            setErr(j.message ?? `HTTP ${res.status}`);
            return;
          }
          router.refresh();
        });
      }}
      className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-700 hover:bg-red-500/20 disabled:opacity-50"
      title={err ?? "Kill this run (SIGTERM or mark interrupted)"}
    >
      {pending ? "…" : err ? "retry" : "kill"}
    </button>
  );
}
