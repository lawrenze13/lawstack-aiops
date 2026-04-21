import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, desc, and, isNull } from "drizzle-orm";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { artifacts, messages, prRecords, runs, tasks } from "@/server/db/schema";
import { RunLog } from "@/components/card-detail/RunLog";
import { RunStarter } from "@/components/card-detail/RunStarter";
import { ResumeBanner } from "@/components/card-detail/ResumeBanner";
import { ChatBox } from "@/components/card-detail/ChatBox";
import { ArchiveButton } from "@/components/card-detail/ArchiveButton";
import { RunSidebar } from "@/components/card-detail/RunSidebar";
import { ApproveButton } from "@/components/card-detail/ApproveButton";
import { ArtifactPanel } from "@/components/card-detail/ArtifactPanel";
import { CardMainTabs } from "@/components/card-detail/CardMainTabs";
import { DescriptionPanel } from "@/components/card-detail/DescriptionPanel";
import { defaultAgentForLane } from "@/server/agents/registry";
import { env } from "@/server/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

export default async function CardDetailPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) return null;
  const { id } = await params;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) notFound();

  // All runs for this task, ordered by when they started. We show every
  // run in the thread log (not only non-superseded ones) so history is
  // complete; the sidebar lets the user jump between them.
  const allRuns = db
    .select()
    .from(runs)
    .where(eq(runs.taskId, id))
    .orderBy(asc(runs.startedAt))
    .all();

  const liveRuns = allRuns.filter((r) => r.supersededAt === null);

  const currentRun = task.currentRunId
    ? allRuns.find((r) => r.id === task.currentRunId)
    : liveRuns[liveRuns.length - 1] ?? allRuns[allRuns.length - 1];

  // Thread view: pull every message from every run on this task, ordered
  // chronologically, so the RunLog can render the full conversation (Brainstorm
  // → Plan → chat replies) as one continuous log.
  const allMessages = db
    .select({
      runId: messages.runId,
      seq: messages.seq,
      type: messages.type,
      payloadJson: messages.payloadJson,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(runs, eq(messages.runId, runs.id))
    .where(eq(runs.taskId, id))
    .orderBy(asc(messages.createdAt), asc(messages.seq))
    .all();

  const threadEvents = allMessages.map((m) => ({
    runId: m.runId,
    seq: m.seq,
    type: m.type as
      | "system"
      | "assistant"
      | "user"
      | "stream_event"
      | "result"
      | "server"
      | "end",
    payload: safeParseJson(m.payloadJson),
  }));

  // Derive live turn count from messages rather than trusting runs.num_turns
  // (which only updates at the final `result` event). This way a still-running
  // run reports accurate in-flight turns.
  const assistantCountByRun = new Map<string, number>();
  for (const m of allMessages) {
    if (m.type === "assistant") {
      assistantCountByRun.set(m.runId, (assistantCountByRun.get(m.runId) ?? 0) + 1);
    }
  }

  const runSummaries = allRuns.map((r) => ({
    id: r.id,
    lane: r.lane,
    agentId: r.agentId,
    status: r.status,
    costUsd: r.costUsdMicros / 1_000_000,
    // For finished runs, trust runs.num_turns (Claude's own final count).
    // For in-flight runs, use the live message count.
    numTurns:
      r.status === "running"
        ? (assistantCountByRun.get(r.id) ?? 0)
        : r.numTurns || (assistantCountByRun.get(r.id) ?? 0),
    startedAt: new Date(r.startedAt).getTime(),
  }));

  // Latest artifact per kind for this task; used both for display and the
  // Approve gate (which requires brainstorm + plan present, non-stale).
  const allArtifacts = db
    .select({
      id: artifacts.id,
      kind: artifacts.kind,
      filename: artifacts.filename,
      markdown: artifacts.markdown,
      isStale: artifacts.isStale,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(eq(artifacts.taskId, id))
    .orderBy(desc(artifacts.createdAt))
    .all();
  const latestArtifactByKind = new Map<
    "brainstorm" | "plan" | "review",
    (typeof allArtifacts)[number]
  >();
  for (const a of allArtifacts) {
    if (!latestArtifactByKind.has(a.kind as "brainstorm" | "plan" | "review")) {
      latestArtifactByKind.set(a.kind as "brainstorm" | "plan" | "review", a);
    }
  }
  const artifactList = Array.from(latestArtifactByKind.values()).map((a) => ({
    kind: a.kind as "brainstorm" | "plan" | "review",
    filename: a.filename,
    markdown: a.markdown,
    isStale: a.isStale,
    createdAt: new Date(a.createdAt).getTime(),
  }));

  const gate = {
    brainstorm: {
      present: latestArtifactByKind.has("brainstorm"),
      stale: latestArtifactByKind.get("brainstorm")?.isStale ?? false,
    },
    plan: {
      present: latestArtifactByKind.has("plan"),
      stale: latestArtifactByKind.get("plan")?.isStale ?? false,
    },
    review: {
      present: latestArtifactByKind.has("review"),
      stale: latestArtifactByKind.get("review")?.isStale ?? false,
    },
  };

  const prRecord = db.select().from(prRecords).where(eq(prRecords.taskId, id)).limit(1).get();
  const prRecordDTO = prRecord
    ? {
        state: prRecord.state,
        prUrl: prRecord.prUrl,
        commitSha: prRecord.commitSha,
        jiraCommentId: prRecord.jiraCommentId,
      }
    : null;

  const canControl =
    (session.user as { role?: string } | undefined)?.role === "admin" ||
    task.ownerId === (session.user as { id?: string } | undefined)?.id;

  const brainstormAgent = defaultAgentForLane("brainstorm");
  const planAgent = defaultAgentForLane("plan");
  const reviewAgent = defaultAgentForLane("review");

  const starterOptions: Array<{
    lane: "brainstorm" | "plan" | "review";
    agentId: string;
    label: string;
  }> = [];
  if (brainstormAgent)
    starterOptions.push({ lane: "brainstorm", agentId: brainstormAgent, label: "Brainstorm" });
  if (planAgent) starterOptions.push({ lane: "plan", agentId: planAgent, label: "Plan" });
  if (reviewAgent)
    starterOptions.push({ lane: "review", agentId: reviewAgent, label: "Review" });

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
          <ApproveButton
            taskId={task.id}
            prRecord={prRecordDTO}
            gate={gate}
            canControl={canControl}
          />
          {canControl ? <ArchiveButton taskId={task.id} jiraKey={task.jiraKey} /> : null}
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
        <aside className="col-span-4 flex min-h-0 flex-col gap-4 overflow-hidden">
          <RunSidebar
            runs={runSummaries}
            currentRunId={currentRun?.id ?? null}
          />
          <DescriptionPanel
            descriptionMd={task.descriptionMd}
            jiraKey={task.jiraKey}
            jiraUrl={env.JIRA_BASE_URL ? `${env.JIRA_BASE_URL}/browse/${task.jiraKey}` : undefined}
          />
          <ArtifactPanel artifacts={artifactList} />
        </aside>

        <div className="col-span-8 flex min-h-0 flex-col">
          {currentRun ? (
            <CardMainTabs
              artifacts={artifactList}
              logContent={
                <div className="flex h-full flex-col">
                  <div className="min-h-0 flex-1">
                    <RunLog
                      runId={currentRun.id}
                      initialStatus={currentRun.status}
                      initialCostUsd={currentRun.costUsdMicros / 1_000_000}
                      initialStartedAtMs={new Date(currentRun.startedAt).getTime()}
                      threadEvents={threadEvents}
                      runs={runSummaries}
                      canControl={canControl}
                    />
                  </div>
                </div>
              }
              chatContent={
                currentRun.claudeSessionId && canControl ? (
                  <ChatBox
                    runId={currentRun.id}
                    canSend={currentRun.status !== "running"}
                    blockedReason={
                      currentRun.status === "running"
                        ? "Run is still streaming — click Stop to chat."
                        : undefined
                    }
                  />
                ) : null
              }
            />
          ) : artifactList.length > 0 ? (
            <CardMainTabs
              artifacts={artifactList}
              logContent={
                <p className="p-6 text-sm text-[color:var(--color-muted-foreground)]">
                  No run log yet — but artifacts from a prior session are available in the tabs.
                </p>
              }
              chatContent={null}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-[color:var(--color-border)] p-6 text-sm text-[color:var(--color-muted-foreground)]">
              No active run for this card. Start one above to see live agent output here.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
