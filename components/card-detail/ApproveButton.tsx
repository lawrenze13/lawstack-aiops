"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import { useToast } from "@/components/toast/ToastHost";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

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
        className="contents"
      >
        <Chip color="success" variant="soft" size="sm">
          ✓ PR opened → view
        </Chip>
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
          className="contents"
        >
          <Chip color="success" variant="soft" size="sm">
            PR opened
          </Chip>
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
        <Chip color="danger" variant="soft" size="sm">
          failed at {failedStep}
        </Chip>
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
      <Button
        {...BUTTON_INTENTS["success-action"]}
        size="sm"
        isDisabled={disabled}
        onPress={() =>
          runApprove(taskId, startTransition, setError, router.refresh.bind(router), toast.push)
        }
      >
        {pending ? "Approving…" : "✓ Approve & PR"}
      </Button>
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
      <Button
        {...BUTTON_INTENTS["retry"]}
        size="sm"
        onPress={onRetry}
        isDisabled={pending}
      >
        {pending ? "Retrying…" : label}
      </Button>
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
