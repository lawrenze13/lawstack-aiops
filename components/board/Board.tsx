"use client";

import { useState, useTransition } from "react";
import { NewTaskDialog } from "./NewTaskDialog";

const LANES = [
  { id: "ticket", label: "Ticket" },
  { id: "branch", label: "Branch" },
  { id: "brainstorm", label: "Brainstorm" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Review" },
  { id: "pr", label: "PR" },
] as const;

type Task = {
  id: string;
  jiraKey: string;
  title: string;
  currentLane: (typeof LANES)[number]["id"] | "done";
  ownerId: string;
};

type Props = {
  initialTasks: Task[];
  scope: "me" | "all";
};

export function Board({ initialTasks, scope }: Props) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [, startTransition] = useTransition();

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
          </nav>
        </div>
        <NewTaskDialog onCreated={refresh} />
      </header>

      <section className="flex flex-1 gap-3 overflow-x-auto p-4">
        {LANES.map((lane) => {
          const inLane = tasks.filter((t) => t.currentLane === lane.id);
          return (
            <div
              key={lane.id}
              className="flex w-72 shrink-0 flex-col rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40"
            >
              <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2">
                <span className="text-sm font-medium">{lane.label}</span>
                <span className="text-xs text-[color:var(--color-muted-foreground)]">
                  {inLane.length}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {inLane.length === 0 ? (
                  <p className="px-1 py-3 text-xs text-[color:var(--color-muted-foreground)]">
                    No cards
                  </p>
                ) : (
                  inLane.map((t) => (
                    <article
                      key={t.id}
                      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-card)] p-3 shadow-sm"
                    >
                      <div className="text-xs font-mono text-[color:var(--color-muted-foreground)]">
                        {t.jiraKey}
                      </div>
                      <div className="mt-1 text-sm font-medium leading-snug">{t.title}</div>
                    </article>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
