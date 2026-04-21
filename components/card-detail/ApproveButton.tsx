"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast/ToastHost";

type PrRecord = {
  state: string;
  prUrl: string | null;
  commitSha: string | null;
  jiraCommentId: string | null;
};

type ArtifactGate = {
  brainstorm: { present: boolean; stale: boolean };
  plan: { present: boolean; stale: boolean };
  review: { present: boolean; stale: boolean };
};

type Props = {
  taskId: string;
  prRecord: PrRecord | null;
  gate: ArtifactGate;
  canControl: boolean;
};

export function ApproveButton({ taskId, prRecord, gate, canControl }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canControl) return null;

  // PR already opened — show the link + optional retry for Jira.
  if (prRecord?.prUrl && prRecord.state === "jira_notified") {
    return (
      <a
        href={prRecord.prUrl}
        target="_blank"
        rel="noreferrer"
        className="rounded-md border border-green-500/40 bg-green-500/10 px-3 py-1 text-xs font-medium text-green-800 hover:bg-green-500/20"
      >
        ✓ PR opened → view
      </a>
    );
  }

  if (prRecord?.prUrl && prRecord.state === "pr_opened") {
    return (
      <div className="flex items-center gap-2">
        <a
          href={prRecord.prUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs text-green-800 hover:bg-green-500/20"
        >
          PR opened
        </a>
        <ApproveRetry
          taskId={taskId}
          label="Retry Jira comment"
          pending={pending}
          onRetry={() => runApprove(taskId, startTransition, setError, router.refresh.bind(router), toast.push)}
          error={error}
        />
      </div>
    );
  }

  // Failed mid-flight — show Retry.
  if (prRecord && prRecord.state.startsWith("failed_at_")) {
    const failedStep = prRecord.state.replace("failed_at_", "");
    return (
      <div className="flex items-center gap-2">
        <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-700">
          failed at {failedStep}
        </span>
        <ApproveRetry
          taskId={taskId}
          label="Retry"
          pending={pending}
          onRetry={() => runApprove(taskId, startTransition, setError, router.refresh.bind(router), toast.push)}
          error={error}
        />
      </div>
    );
  }

  // Fresh approval. Gate first.
  const gateErrors: string[] = [];
  if (!gate.brainstorm.present) gateErrors.push("brainstorm missing");
  else if (gate.brainstorm.stale) gateErrors.push("brainstorm stale — re-run");
  if (!gate.plan.present) gateErrors.push("plan missing");
  else if (gate.plan.stale) gateErrors.push("plan stale — re-run");

  const disabled = gateErrors.length > 0 || pending;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          runApprove(taskId, startTransition, setError, router.refresh.bind(router), toast.push)
        }
        className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-[color:var(--color-muted)] disabled:text-[color:var(--color-muted-foreground)]"
        title={gateErrors.length > 0 ? gateErrors.join(" · ") : "Commit, push, open draft PR, comment on Jira"}
      >
        {pending ? "Approving…" : "✓ Approve & PR"}
      </button>
      {gateErrors.length > 0 ? (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {gateErrors.join(" · ")}
        </span>
      ) : null}
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}

function ApproveRetry({
  label,
  pending,
  onRetry,
  error,
}: {
  taskId: string;
  label: string;
  pending: boolean;
  onRetry: () => void;
  error: string | null;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onRetry}
        disabled={pending}
        className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-500/20 disabled:opacity-50"
      >
        {pending ? "Retrying…" : label}
      </button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </>
  );
}

function runApprove(
  taskId: string,
  startTransition: (cb: () => void) => void,
  setError: (v: string | null) => void,
  refresh: () => void,
  toastPush: (t: { kind: "success" | "error" | "warn" | "info"; title: string; body?: string }) => void,
): void {
  setError(null);
  startTransition(async () => {
    const res = await fetch(`/api/tasks/${taskId}/approve`, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      failedAt?: string;
      error?: string;
      message?: string;
      jiraWarning?: string | null;
      prUrl?: string;
    };
    if (!res.ok) {
      const msg = json.message ?? `HTTP ${res.status}`;
      setError(msg);
      toastPush({ kind: "error", title: "Approve failed", body: msg });
      refresh();
      return;
    }
    if (json.ok === false) {
      const msg = `failed at ${json.failedAt}: ${json.error}`;
      setError(msg);
      toastPush({ kind: "error", title: "Approve failed", body: msg });
      refresh();
      return;
    }
    if (json.jiraWarning) {
      setError(json.jiraWarning);
      toastPush({
        kind: "warn",
        title: "PR opened; Jira comment failed",
        body: json.jiraWarning,
      });
    } else {
      toastPush({
        kind: "success",
        title: "PR opened",
        body: json.prUrl ?? undefined,
      });
    }
    refresh();
  });
}
