"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DragDropProvider,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { Chip } from "@heroui/react/chip";
import { NewTaskDialog } from "./NewTaskDialog";

const LANES = [
  { id: "ticket", label: "Ticket" },
  { id: "branch", label: "Branch" },
  { id: "brainstorm", label: "Brainstorm" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Review" },
  { id: "pr", label: "PR" },
  { id: "implement", label: "Implement" },
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
    | "awaiting_input"
    | null;
  costUsd: number;
  prState: string | null;
  prUrl: string | null;
};

type Props = {
  initialTasks: Task[];
  scope: "me" | "all";
};

export function Board({ initialTasks, scope }: Props) {
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
      implement: [],
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
    // Desktop: AppShell's main is the scroll container (h-screen) so
    // h-full here = viewport height. Mobile: AppShell main has no
    // fixed height, so h-full collapses — give the board an explicit
    // min-height of (100vh − sticky-top-bar) so lane columns actually
    // have vertical room to render.
    <div className="flex h-full min-h-[calc(100vh-56px)] flex-col lg:min-h-0">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border)] bg-[color:var(--background)]/80 px-4 backdrop-blur md:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--accent)]">
            {scope === "me" ? "01" : "—"}
          </span>
          <h1 className="truncate text-base font-semibold">
            {scope === "me" ? "My Tasks" : "Team Board"}
          </h1>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)] md:inline">
            board
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {error ? (
            <span className="hidden text-xs text-red-700 md:inline" title={error}>
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
        {/* 4×2 grid so all 8 lanes fit without horizontal scroll on
            desktop. Reading order = flow order: left→right, then wrap
            down. The lane header number (01..08) and the → / ↩ arrows
            make the progression explicit even when the grid wraps. */}
        <section className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-4">
          {LANES.map((lane, i) => {
            const isLast = i === LANES.length - 1;
            const isRowEnd = (i + 1) % 4 === 0 && !isLast;
            return (
              <LaneColumn
                key={lane.id}
                id={lane.id}
                number={i + 1}
                label={lane.label}
                count={tasksByLane[lane.id].length}
                nextArrow={isLast ? "end" : isRowEnd ? "wrap" : "right"}
              >
                {tasksByLane[lane.id].length > 0 ? (
                  tasksByLane[lane.id].map((t) => (
                    <DraggableCard key={t.id} task={t} />
                  ))
                ) : (
                  <p className="px-1 py-3 text-xs text-[color:var(--muted)]">
                    No cards
                  </p>
                )}
              </LaneColumn>
            );
          })}
        </section>
      </DragDropProvider>
    </div>
  );
}

function LaneColumn({
  id,
  number,
  label,
  count,
  nextArrow,
  children,
}: {
  id: LaneId;
  number: number;
  label: string;
  count: number;
  /** "right" = flow continues to the lane to the right.
      "wrap"  = lane is last-in-row, flow continues on the row below.
      "end"   = terminal lane (done), no arrow. */
  nextArrow: "right" | "wrap" | "end";
  children: React.ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({ id, accept: "item" });
  const paddedNum = String(number).padStart(2, "0");
  return (
    <div
      className={`relative flex min-h-[260px] flex-col rounded-lg border bg-[color:var(--surface-secondary)]/40 transition-colors ${
        isDropTarget
          ? "border-[color:var(--accent)]/70 bg-[color:var(--accent)]/5"
          : "border-[color:var(--border)]"
      }`}
    >
      <div className="flex items-center justify-between border-b border-[color:var(--border)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)]">
            {paddedNum}
          </span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        <span className="text-xs text-[color:var(--muted)]">{count}</span>
      </div>
      <div
        ref={ref}
        className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {children}
      </div>

      {/* Flow arrow pointing to the next lane. Hidden on mobile 1-col
          layout, visible on sm+ where columns actually sit side-by-side. */}
      {nextArrow !== "end" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute z-10 hidden items-center justify-center text-[color:var(--muted)] sm:flex"
          style={
            nextArrow === "right"
              ? { right: "-0.65rem", top: "50%", transform: "translateY(-50%)" }
              : // wrap: sits under the column, hinting the row below.
                { bottom: "-0.9rem", right: "0.5rem" }
          }
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--background)] font-mono text-[10px]">
            {nextArrow === "right" ? "→" : "↴"}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function DraggableCard({ task }: { task: Task }) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();
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

  const navigate = () => {
    // useTransition lets us show a pending state while Next.js is
    // server-rendering the destination page. `navigating` stays true
    // until the new route's render completes (or the loading.tsx
    // skeleton takes over).
    startNav(() => router.push(`/cards/${task.id}`));
  };

  return (
    <div
      ref={ref}
      data-task-id={task.id}
      className={`relative rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-3 shadow-sm transition-shadow select-none ${
        isDragging
          ? "opacity-40 ring-2 ring-blue-500/60 shadow-lg cursor-grabbing"
          : navigating
            ? "cursor-progress opacity-80"
            : "cursor-grab hover:border-blue-500/30"
      }`}
      onPointerDown={(e) => {
        downRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      }}
      onPointerUp={(e) => {
        const d = downRef.current;
        downRef.current = null;
        if (!d || isDragging || navigating) return;
        const dx = Math.abs(e.clientX - d.x);
        const dy = Math.abs(e.clientY - d.y);
        const dt = Date.now() - d.t;
        // Treat as click: movement < 5px AND duration < 500ms.
        if (dx < 5 && dy < 5 && dt < 500) {
          navigate();
        }
      }}
    >
      {/* Loading overlay while navigating — accent-green spinner matches
          the "signal room" aesthetic. Pointer-events-none so the overlay
          doesn't eat subsequent clicks. */}
      {navigating ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-[color:var(--surface)]/70">
          <svg
            className="h-5 w-5 animate-spin text-[color:var(--accent)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden
          >
            <path d="M21 12a9 9 0 11-6.22-8.56" />
          </svg>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-[color:var(--muted)]">
          {task.jiraKey}
        </span>
        <CardStatusBadges task={task} />
      </div>
      <div className="mt-1 text-sm font-medium leading-snug">{task.title}</div>
      {task.costUsd > 0 ? (
        <div className="mt-1.5 text-[10px] text-[color:var(--muted)]">
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
        <Chip color="success" variant="primary" size="sm" className="uppercase text-[9px]">
          live
        </Chip>
      ) : null}
      {s === "failed" || s === "cost_killed" ? (
        <Chip color="danger" variant="soft" size="sm" className="uppercase text-[9px]">
          {s === "cost_killed" ? "$$$" : "failed"}
        </Chip>
      ) : null}
      {s === "interrupted" ? (
        <Chip color="warning" variant="soft" size="sm" className="uppercase text-[9px]">
          paused
        </Chip>
      ) : null}
      {s === "awaiting_input" ? (
        <Chip color="accent" variant="soft" size="sm" className="uppercase text-[9px]">
          waiting
        </Chip>
      ) : null}
      {task.prState === "jira_notified" || task.prState === "pr_opened" ? (
        <Chip color="accent" variant="primary" size="sm" className="uppercase text-[9px]">
          PR
        </Chip>
      ) : null}
      {task.prState?.startsWith("failed_at_") ? (
        <Chip color="danger" variant="soft" size="sm" className="uppercase text-[9px]">
          PR ✘
        </Chip>
      ) : null}
    </span>
  );
}
