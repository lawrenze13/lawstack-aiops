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
  /** Multi-cycle support. Defaults to 1 to avoid call-site churn at
   *  pre-existing usages. When > 1, the button skips the cycle-1
   *  terminal-state chips (the prRecord is at `jira_notified` from
   *  cycle 1, but cycle 2's fresh artifacts still need pushing) and
   *  always renders the action button labeled "Push cycle N to PR". */
  cycleNumber?: number;
};

export function ApproveButton({
  taskId,
  prRecord,
  gate,
  canControl,
  cycleNumber = 1,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canControl) return null;

  const inMultiCycle = cycleNumber > 1;

  // CYCLE 1 ONLY: render terminal-state chips. Cycle N>1 doesn't update
  // prRecords.state past `jira_notified` (approveCycle deliberately
  // doesn't touch the state machine), so on cycle N>1 we always fall
  // through to the action button below.
  if (!inMultiCycle) {
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
            onRetry={() =>
              runApprove(
                taskId,
                startTransition,
                setError,
                router.refresh.bind(router),
                toast.push,
                cycleNumber,
              )
            }
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
            onRetry={() =>
              runApprove(
                taskId,
                startTransition,
                setError,
                router.refresh.bind(router),
                toast.push,
                cycleNumber,
              )
            }
            error={error}
          />
        </div>
      );
    }
  }

  // Fresh approval (cycle 1) OR cycle N>1 push. Gate first — same
  // artifact-staleness check applies in both cases.
  const gateErrors: string[] = [];
  if (!gate.brainstorm.present) gateErrors.push("brainstorm missing");
  else if (gate.brainstorm.stale) gateErrors.push("brainstorm stale — re-run");
  if (!gate.plan.present) gateErrors.push("plan missing");
  else if (gate.plan.stale) gateErrors.push("plan stale — re-run");

  const disabled = gateErrors.length > 0 || pending;
  const label = inMultiCycle
    ? `↑ Push cycle ${cycleNumber} to PR`
    : "✓ Approve & PR";
  const pendingLabel = inMultiCycle ? "Pushing…" : "Approving…";

  return (
    <div className="flex items-center gap-2">
      {inMultiCycle && prRecord?.prUrl ? (
        <a
          href={prRecord.prUrl}
          target="_blank"
          rel="noreferrer"
          className="contents"
        >
          <Chip color="default" variant="soft" size="sm">
            PR ↗
          </Chip>
        </a>
      ) : null}
      <Button
        {...BUTTON_INTENTS["success-action"]}
        size="sm"
        isDisabled={disabled}
        onPress={() =>
          runApprove(
            taskId,
            startTransition,
            setError,
            router.refresh.bind(router),
            toast.push,
            cycleNumber,
          )
        }
      >
        {pending ? pendingLabel : label}
      </Button>
      {gateErrors.length > 0 ? (
        <span className="text-[10px] text-[color:var(--muted)]">
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
  cycleNumber: number,
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
      // Cycle N>1 response shape (from approveCycle):
      cycleNumber?: number;
      pushed?: boolean;
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
    // Cycle N>1 success path — different toast.
    if (cycleNumber > 1) {
      toastPush({
        kind: "success",
        title: `Cycle ${cycleNumber} pushed to PR`,
        body: json.pushed === false
          ? "no artifact changes — push was a no-op"
          : json.prUrl ?? undefined,
      });
      refresh();
      return;
    }
    // Cycle 1 success path.
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
