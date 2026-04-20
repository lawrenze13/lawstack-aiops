"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  taskId: string;
  runId: string;
  lane: "brainstorm" | "plan" | "review";
  agentId: string;
  claudeSessionId: string | null;
  killedReason: string | null;
  canControl: boolean;
};

export function ResumeBanner({
  taskId,
  runId,
  lane,
  agentId,
  claudeSessionId,
  killedReason,
  canControl,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const resume = () => {
    setError(null);
    startTransition(async () => {
      const body: Record<string, unknown> = { lane, agentId };
      if (claudeSessionId) body.resumeSessionId = claudeSessionId;
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setError(j.message ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="mx-6 mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
      <div className="flex items-center justify-between">
        <div>
          <strong>This run stopped without finishing.</strong>{" "}
          <span className="text-amber-800">
            {killedReason === "server_restart"
              ? "The dev server restarted mid-run (or the Node process exited). The subprocess is gone, but the Claude session id is saved — click Resume to pick up where it left off."
              : `No live subprocess is attached. Reason: ${killedReason ?? "unknown"}. The events below are historical.`}
          </span>
          <div className="mt-0.5 font-mono text-xs text-amber-700">
            run {runId.slice(0, 8)} · lane={lane} · agent={agentId}
            {claudeSessionId ? ` · session=${claudeSessionId.slice(0, 8)}` : ""}
          </div>
        </div>
        {canControl ? (
          <button
            type="button"
            onClick={resume}
            disabled={pending || !claudeSessionId}
            title={claudeSessionId ? undefined : "No Claude session id captured — Resume unavailable"}
            className="rounded border border-amber-600 bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {pending ? "Resuming…" : "Resume"}
          </button>
        ) : null}
      </div>
      {error ? <div className="mt-1 text-xs text-red-700">Resume failed: {error}</div> : null}
    </div>
  );
}
