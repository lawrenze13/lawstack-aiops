"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DragDropProvider,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { NewTaskDialog } from "./NewTaskDialog";

const LANES = [
  { id: "ticket", label: "Ticket" },
  { id: "branch", label: "Branch" },
  { id: "brainstorm", label: "Brainstorm" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Review" },
  { id: "pr", label: "PR" },
  { id: "done", label: "Done" },
] as const;
type LaneId = (typeof LANES)[number]["id"];
const LANE_IDS = LANES.map((l) => l.id) as readonly LaneId[];

type Task = {
  id: string;
  jiraKey: string;
  title: string;
  currentLane: LaneId;
  ownerId: string;
  runStatus:
    | "running"
    | "completed"
    | "failed"
    | "stopped"
    | "cost_killed"
    | "interrupted"
    | null;
  costUsd: number;
  prState: string | null;
  prUrl: string | null;
};

type Props = {
  initialTasks: Task[];
  scope: "me" | "all";
  isAdmin?: boolean;
};

export function Board({ initialTasks, scope, isAdmin }: Props) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const previousSnapshot = useRef<Task[]>(initialTasks);

  const tasksByLane = useMemo(() => {
    const out: Record<LaneId, Task[]> = {
      ticket: [],
      branch: [],
      brainstorm: [],
      plan: [],
      review: [],
      pr: [],
      done: [],
    };
    for (const t of tasks) out[t.currentLane].push(t);
    return out;
  }, [tasks]);

  const refresh = () => {
    startTransition(async () => {
      const res = await fetch(`/api/tasks?scope=${scope}`, { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { tasks: Task[] };
        setTasks(json.tasks);
      }
    });
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold">multiportal-ai-ops</h1>
          <nav className="flex gap-2 text-sm">
            <a
              href="/"
              className={`rounded-md px-3 py-1 ${scope === "me" ? "bg-[color:var(--color-muted)]" : ""}`}
            >
              My Tasks
            </a>
            <a
              href="/team"
              className={`rounded-md px-3 py-1 ${scope === "all" ? "bg-[color:var(--color-muted)]" : ""}`}
            >
              Team Board
            </a>
            {isAdmin ? (
              <a
                href="/admin/ops"
                className="rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-1 text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
                title="Admin ops (stuck runs, cost/day, worktree disk)"
              >
                ⚙ Admin
              </a>
            ) : null}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {error ? (
            <span className="text-xs text-red-700" title={error}>
              {error.slice(0, 80)}
              {error.length > 80 ? "…" : ""}
            </span>
          ) : null}
          <NewTaskDialog onCreated={refresh} />
        </div>
      </header>

      <DragDropProvider
        onDragStart={() => {
          previousSnapshot.current = tasks;
          setError(null);
        }}
        onDragEnd={async (event) => {
          if (event.canceled) return;

          // The v2 API returns operation.source (draggable) + operation.target
          // (current droppable, nullable). Find which lane we dropped on.
          const op = event.operation as unknown as {
            source: { id: string } | null;
            target: { id: string } | null;
          };
          const taskId = String(op.source?.id ?? "");
          const targetLane = String(op.target?.id ?? "") as LaneId;
          if (!taskId || !LANE_IDS.includes(targetLane)) return;

          const src = tasks.find((t) => t.id === taskId);
          if (!src || src.currentLane === targetLane) return;

          // Optimistic update.
          setTasks((prev) =>
            prev.map((t) => (t.id === taskId ? { ...t, currentLane: targetLane } : t)),
          );

          const res = await fetch(`/api/tasks/${taskId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lane: targetLane }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { message?: string };
            setError(body.message ?? `move failed: HTTP ${res.status}`);
            setTasks(previousSnapshot.current);
          }
        }}
      >
        <section className="flex flex-1 gap-3 overflow-x-auto p-4">
          {LANES.map((lane) => (
            <LaneColumn
              key={lane.id}
              id={lane.id}
              label={lane.label}
              count={tasksByLane[lane.id].length}
            >
              {tasksByLane[lane.id].length > 0 ? (
                tasksByLane[lane.id].map((t) => (
                  <DraggableCard key={t.id} task={t} />
                ))
              ) : (
                <p className="px-1 py-3 text-xs text-[color:var(--color-muted-foreground)]">
                  No cards
                </p>
              )}
            </LaneColumn>
          ))}
        </section>
      </DragDropProvider>
    </div>
  );
}

function LaneColumn({
  id,
  label,
  count,
  children,
}: {
  id: LaneId;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({ id, accept: "item" });
  return (
    <div
      className={`flex w-72 shrink-0 flex-col rounded-lg border bg-[color:var(--color-muted)]/40 transition-colors ${
        isDropTarget ? "border-blue-500/60 bg-blue-500/5" : "border-[color:var(--color-border)]"
      }`}
    >
      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">{count}</span>
      </div>
      <div
        ref={ref}
        className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {children}
      </div>
    </div>
  );
}

function DraggableCard({ task }: { task: Task }) {
  const router = useRouter();
  const { ref, isDragging } = useDraggable({
    id: task.id,
    type: "item",
  });

  // Navigate on click — but only if the user didn't drag. dnd-kit's
  // activation constraint means isDragging flips true only after the
  // pointer has moved beyond the threshold, so a plain click (no
  // movement) leaves isDragging=false and the click navigates.
  // Pointer tracking lets us absolutely avoid the edge case where
  // click fires at the end of a successful drag.
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null);

  return (
    <div
      ref={ref}
      data-task-id={task.id}
      className={`rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-card)] p-3 shadow-sm transition-shadow select-none ${
        isDragging
          ? "opacity-40 ring-2 ring-blue-500/60 shadow-lg cursor-grabbing"
          : "cursor-grab hover:border-blue-500/30"
      }`}
      onPointerDown={(e) => {
        downRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      }}
      onPointerUp={(e) => {
        const d = downRef.current;
        downRef.current = null;
        if (!d || isDragging) return;
        const dx = Math.abs(e.clientX - d.x);
        const dy = Math.abs(e.clientY - d.y);
        const dt = Date.now() - d.t;
        // Treat as click: movement < 5px AND duration < 500ms.
        if (dx < 5 && dy < 5 && dt < 500) {
          router.push(`/cards/${task.id}`);
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-[color:var(--color-muted-foreground)]">
          {task.jiraKey}
        </span>
        <CardStatusBadges task={task} />
      </div>
      <div className="mt-1 text-sm font-medium leading-snug">{task.title}</div>
      {task.costUsd > 0 ? (
        <div className="mt-1.5 text-[10px] text-[color:var(--color-muted-foreground)]">
          ${task.costUsd.toFixed(4)}
        </div>
      ) : null}
    </div>
  );
}

function CardStatusBadges({ task }: { task: Task }) {
  const s = task.runStatus;
  return (
    <span className="flex items-center gap-1">
      {s === "running" ? (
        <span
          className="flex items-center gap-1 rounded border border-green-500/40 bg-green-500/10 px-1 py-0.5 text-[9px] font-medium uppercase text-green-700"
          title="agent running"
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
          live
        </span>
      ) : null}
      {s === "failed" || s === "cost_killed" ? (
        <span
          className="rounded border border-red-500/40 bg-red-500/10 px-1 py-0.5 text-[9px] font-medium uppercase text-red-700"
          title={s}
        >
          {s === "cost_killed" ? "$$$" : "failed"}
        </span>
      ) : null}
      {s === "interrupted" ? (
        <span
          className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium uppercase text-amber-800"
          title="interrupted — click to resume"
        >
          paused
        </span>
      ) : null}
      {task.prState === "jira_notified" || task.prState === "pr_opened" ? (
        <span
          className="rounded border border-blue-500/40 bg-blue-500/10 px-1 py-0.5 text-[9px] font-medium uppercase text-blue-700"
          title={`PR ${task.prState}`}
        >
          PR
        </span>
      ) : null}
      {task.prState?.startsWith("failed_at_") ? (
        <span
          className="rounded border border-red-500/40 bg-red-500/10 px-1 py-0.5 text-[9px] font-medium uppercase text-red-700"
          title={task.prState}
        >
          PR ✘
        </span>
      ) : null}
    </span>
  );
}
