import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, desc, and, isNull } from "drizzle-orm";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { runs, tasks } from "@/server/db/schema";
import { RunLog } from "@/components/card-detail/RunLog";
import { RunStarter } from "@/components/card-detail/RunStarter";
import { ResumeBanner } from "@/components/card-detail/ResumeBanner";
import { ChatBox } from "@/components/card-detail/ChatBox";
import { defaultAgentForLane } from "@/server/agents/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function CardDetailPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) return null;
  const { id } = await params;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) notFound();

  // Latest live (non-superseded) run per lane.
  const liveRuns = db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, id), isNull(runs.supersededAt)))
    .orderBy(desc(runs.startedAt))
    .all();

  const currentRun = task.currentRunId
    ? liveRuns.find((r) => r.id === task.currentRunId)
    : liveRuns[0];

  const brainstormAgent = defaultAgentForLane("brainstorm");
  const planAgent = defaultAgentForLane("plan");
  const reviewAgent = defaultAgentForLane("review");

  const starterOptions: Array<{
    lane: "brainstorm" | "plan" | "review";
    agentId: string;
    label: string;
  }> = [];
  if (brainstormAgent)
    starterOptions.push({ lane: "brainstorm", agentId: brainstormAgent, label: "Run Brainstorm" });
  if (planAgent) starterOptions.push({ lane: "plan", agentId: planAgent, label: "Run Plan" });
  if (reviewAgent)
    starterOptions.push({ lane: "review", agentId: reviewAgent, label: "Run Review" });

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-6 py-3">
        <div>
          <Link
            href="/"
            className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
          >
            ← Board
          </Link>
          <h1 className="mt-1 text-lg font-semibold">
            <span className="font-mono text-[color:var(--color-muted-foreground)]">
              {task.jiraKey}
            </span>{" "}
            {task.title}
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="rounded bg-[color:var(--color-muted)] px-2 py-1 font-medium">
            lane: {task.currentLane}
          </span>
        </div>
      </header>

      {currentRun && currentRun.status === "interrupted" && currentRun.lane !== "pr" ? (
        <ResumeBanner
          taskId={task.id}
          runId={currentRun.id}
          lane={currentRun.lane as "brainstorm" | "plan" | "review"}
          agentId={currentRun.agentId}
          claudeSessionId={currentRun.claudeSessionId}
          killedReason={currentRun.killedReason}
          canControl={
            (session.user as { role?: string } | undefined)?.role === "admin" ||
            task.ownerId === (session.user as { id?: string } | undefined)?.id
          }
        />
      ) : null}

      <section className="border-b border-[color:var(--color-border)] px-6 py-3">
        <RunStarter taskId={task.id} options={starterOptions} />
      </section>

      <section className="grid flex-1 min-h-0 grid-cols-12 gap-4 p-4">
        <aside className="col-span-4 overflow-y-auto rounded-lg border border-[color:var(--color-border)] p-3">
          <h2 className="text-sm font-semibold">Runs</h2>
          {liveRuns.length === 0 ? (
            <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
              No runs yet. Click a button above to start one.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {liveRuns.map((r) => (
                <li
                  key={r.id}
                  className={`rounded border px-2 py-1.5 text-xs ${currentRun?.id === r.id ? "border-blue-500/40 bg-blue-500/5" : "border-[color:var(--color-border)]"}`}
                >
                  <div className="font-mono">{r.lane}</div>
                  <div className="text-[color:var(--color-muted-foreground)]">
                    {r.agentId} · {r.status} · ${(r.costUsdMicros / 1_000_000).toFixed(4)}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {task.descriptionMd ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-semibold">
                Jira description
              </summary>
              <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-[color:var(--color-muted-foreground)]">
                {task.descriptionMd}
              </pre>
            </details>
          ) : null}
        </aside>

        <div className="col-span-8 flex min-h-0 flex-col rounded-lg border border-[color:var(--color-border)]">
          {currentRun ? (
            <>
              <div className="min-h-0 flex-1">
                <RunLog
                  runId={currentRun.id}
                  initialStatus={currentRun.status}
                  initialCostUsd={currentRun.costUsdMicros / 1_000_000}
                  canControl={
                    (session.user as { role?: string } | undefined)?.role === "admin" ||
                    task.ownerId === (session.user as { id?: string } | undefined)?.id
                  }
                />
              </div>
              {currentRun.claudeSessionId &&
              ((session.user as { role?: string } | undefined)?.role === "admin" ||
                task.ownerId === (session.user as { id?: string } | undefined)?.id) ? (
                <ChatBox
                  runId={currentRun.id}
                  canSend={currentRun.status !== "running"}
                  blockedReason={
                    currentRun.status === "running"
                      ? "Run is still streaming — click Stop to chat."
                      : undefined
                  }
                />
              ) : null}
            </>
          ) : (
            <p className="p-6 text-sm text-[color:var(--color-muted-foreground)]">
              No active run for this card. Start one above to see live agent output here.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
