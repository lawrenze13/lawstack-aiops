"use client";

import { useEffect, useState } from "react";
import { CardMainTabs, type CardArtifact } from "./CardMainTabs";
import { ChatBox } from "./ChatBox";
import { RunLog, type EventRow, type RunSummary } from "./RunLog";

// Why this client wrapper exists:
//
// The card-detail page is a server component. After a chat message lands,
// the message endpoint creates a NEW run row (resumeRun → fresh runId)
// and updates `tasks.currentRunId` server-side. The client needs that
// new runId IMMEDIATELY so RunLog can rebind its SSE stream to the new
// run, otherwise it stays attached to the old run and misses every
// event from the new turn.
//
// Without this wrapper the only path was `router.refresh()` — slow,
// and `useTransition` would freeze the Send button for the whole
// server-render round-trip. With this wrapper:
//
//   1. ChatBox reads the new runId from POST response body.
//   2. ChatBox calls `onRunIdChanged(newId)`.
//   3. CardThread's `useState` updates → re-renders RunLog with new
//      runId prop → RunLog's `useEffect([runId])` closes old SSE,
//      opens new one — within ~1 React tick.
//
// The `useEffect(() => setRunId(initialRunId), [initialRunId])` syncs
// down server-pushed updates (auto-advance creating a new run while
// the operator is on a different tab; full page navigation between
// cards). Page-level `key={taskId}` on this component forces a fresh
// instance when navigating between cards (security: prevents a
// stale runId from leaking across cards).

export type RunLite = {
  /** Run status — drives `canSend` (chat is blocked while running). */
  status: string;
  costUsd: number;
  startedAtMs: number;
  /** Truthy when the run has a Claude session id (chat available). */
  claudeSessionId: string | null;
};

type Props = {
  /** Server-rendered current runId. Seeds local state; resyncs on change. */
  initialRunId: string;
  /** Server-rendered current run snapshot. Same resync-on-change semantics. */
  initialRun: RunLite;
  /** Persisted events from ALL runs on this task — RunLog seed. */
  threadEvents: EventRow[];
  /** Per-run metadata for the in-log run headers. */
  runs: RunSummary[];
  canControl: boolean;
  /** Pass-through CardMainTabs props. */
  taskId: string;
  artifacts: CardArtifact[];
  showChanges: boolean;
  showShell: boolean;
  shellCwd?: string | null;
  shellCanControl?: boolean;
};

export function CardThread({
  initialRunId,
  initialRun,
  threadEvents,
  runs,
  canControl,
  taskId,
  artifacts,
  showChanges,
  showShell,
  shellCwd,
  shellCanControl,
}: Props) {
  const [runId, setRunId] = useState(initialRunId);
  const [runLite, setRunLite] = useState<RunLite>(initialRun);

  // Sync down server-pushed updates. When the page re-renders (e.g.,
  // after auto-advance creates a new run, or a full route navigation),
  // the props change and we adopt the new server state.
  useEffect(() => {
    setRunId(initialRunId);
  }, [initialRunId]);
  useEffect(() => {
    setRunLite(initialRun);
  }, [initialRun]);

  // Optimistic update on chat send: the server-created run will be
  // "running" with a fresh Claude session and zero cost so far. Until
  // the server-component refresh lands and overwrites this via the
  // useEffect above, RunLog and ChatBox render with these defaults.
  // `claudeSessionId` is set to a placeholder so ChatBox stays mounted
  // (the actual session id isn't needed client-side — only its truthiness
  // gates the chat surface).
  const handleRunIdChanged = (nextRunId: string) => {
    setRunId(nextRunId);
    setRunLite({
      status: "running",
      costUsd: 0,
      startedAtMs: Date.now(),
      claudeSessionId: "pending",
    });
  };

  const logContent = (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <RunLog
          runId={runId}
          initialStatus={runLite.status}
          initialCostUsd={runLite.costUsd}
          initialStartedAtMs={runLite.startedAtMs}
          threadEvents={threadEvents}
          runs={runs}
          canControl={canControl}
        />
      </div>
    </div>
  );

  const chatContent = runLite.claudeSessionId && canControl ? (
    <ChatBox
      runId={runId}
      onRunIdChanged={handleRunIdChanged}
      canSend={runLite.status !== "running"}
      blockedReason={
        runLite.status === "running"
          ? "Run is still streaming — click Stop to chat."
          : undefined
      }
    />
  ) : null;

  return (
    <CardMainTabs
      artifacts={artifacts}
      taskId={taskId}
      showChanges={showChanges}
      showShell={showShell}
      shellCwd={shellCwd}
      shellCanControl={shellCanControl}
      logContent={logContent}
      chatContent={chatContent}
    />
  );
}
