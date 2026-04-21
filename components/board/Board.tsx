"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
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

type Task = {
  id: string;
  jiraKey: string;
  title: string;
  currentLane: LaneId;
  ownerId: string;
};

type Props = {
  initialTasks: Task[];
  scope: "me" | "all";
};

// Shape the dnd-kit helpers expect — an object keyed by group (lane) with
// arrays of item ids.
type ItemsByLane = Record<LaneId, string[]>;

export function Board({ initialTasks, scope }: Props) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Derive the per-lane id arrays for dnd-kit.
  const [items, setItems] = useState<ItemsByLane>(() => groupByLane(initialTasks));
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const previousItems = useRef<ItemsByLane>(items);

  const refresh = () => {
    startTransition(async () => {
      const res = await fetch(`/api/tasks?scope=${scope}`, { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { tasks: Task[] };
        setTasks(json.tasks);
        setItems(groupByLane(json.tasks));
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
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {error ? (
            <span className="text-xs text-red-700" title={error}>
              {error.slice(0, 60)}
              {error.length > 60 ? "…" : ""}
            </span>
          ) : null}
          <NewTaskDialog onCreated={refresh} />
        </div>
      </header>

      <DragDropProvider
        onDragStart={() => {
          previousItems.current = items;
          setError(null);
        }}
        onDragOver={(event) => {
          setItems((prev) => move(prev, event));
        }}
        onDragEnd={async (event) => {
          if (event.canceled) {
            setItems(previousItems.current);
            return;
          }
          // Find which lane each task ended up in. Persist lane changes
          // for any task whose lane actually moved.
          const moves: Array<{ id: string; lane: LaneId }> = [];
          for (const laneId of Object.keys(items) as LaneId[]) {
            for (const id of items[laneId]) {
              const t = tasksById.get(id);
              if (t && t.currentLane !== laneId) {
                moves.push({ id, lane: laneId });
              }
            }
          }
          if (moves.length === 0) return;

          for (const m of moves) {
            const res = await fetch(`/api/tasks/${m.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ lane: m.lane }),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { message?: string };
              setError(body.message ?? `move failed: HTTP ${res.status}`);
              setItems(previousItems.current);
              return;
            }
          }

          // Success — update the task list mirror.
          setTasks((prev) =>
            prev.map((t) => {
              const hit = moves.find((m) => m.id === t.id);
              return hit ? { ...t, currentLane: hit.lane } : t;
            }),
          );
        }}
      >
        <section className="flex flex-1 gap-3 overflow-x-auto p-4">
          {LANES.map((lane, laneIdx) => (
            <LaneColumn
              key={lane.id}
              id={lane.id}
              label={lane.label}
              index={laneIdx}
              count={items[lane.id]?.length ?? 0}
            >
              {items[lane.id]?.length ? (
                items[lane.id].map((id, i) => {
                  const t = tasksById.get(id);
                  if (!t) return null;
                  return <DraggableCard key={id} task={t} index={i} laneId={lane.id} />;
                })
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
  index,
  count,
  children,
}: {
  id: LaneId;
  label: string;
  index: number;
  count: number;
  children: React.ReactNode;
}) {
  const { ref } = useSortable({
    id,
    index,
    type: "lane",
    accept: ["item", "lane"],
    collisionPriority: 1,
  });
  return (
    <div
      ref={ref as unknown as React.Ref<HTMLDivElement>}
      className="flex w-72 shrink-0 flex-col rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40"
    >
      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">{count}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">{children}</div>
    </div>
  );
}

function DraggableCard({
  task,
  index,
  laneId,
}: {
  task: Task;
  index: number;
  laneId: LaneId;
}) {
  const { ref, isDragging } = useSortable({
    id: task.id,
    index,
    type: "item",
    accept: "item",
    group: laneId,
  });

  return (
    <div
      ref={ref as unknown as React.Ref<HTMLDivElement>}
      className={`rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-card)] shadow-sm ${
        isDragging ? "opacity-50 ring-2 ring-blue-500/40" : ""
      }`}
    >
      <Link
        href={`/cards/${task.id}`}
        className="block p-3"
        // Prevent link navigation when a drag is in flight.
        onClick={(e) => {
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="text-xs font-mono text-[color:var(--color-muted-foreground)]">
          {task.jiraKey}
        </div>
        <div className="mt-1 text-sm font-medium leading-snug">{task.title}</div>
      </Link>
    </div>
  );
}

function groupByLane(tasks: Task[]): ItemsByLane {
  const out: ItemsByLane = {
    ticket: [],
    branch: [],
    brainstorm: [],
    plan: [],
    review: [],
    pr: [],
    done: [],
  };
  for (const t of tasks) {
    out[t.currentLane].push(t.id);
  }
  return out;
}
