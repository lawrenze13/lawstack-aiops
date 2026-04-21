import { spawn } from "node:child_process";
import readline from "node:readline";
import { eq, sql } from "drizzle-orm";
import { db, sqlite } from "@/server/db/client";
import { messages as messagesTable, runs, tasks } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { getRunBus, closeRunBus, type RunEvent } from "./runBus";
import { runRegistry, type StopReason } from "./runRegistry";
import { parseStreamLine } from "./streamParser";
import {
  clearMeter,
  finalizeMeter,
  initMeter,
  observeAssistantUsage,
} from "./costMeter";

export type SpawnAgentParams = {
  runId: string;
  taskId: string;
  prompt: string;
  sessionId: string;
  model: string;
  worktreePath: string;
  /** Resume an existing Claude session id instead of starting a fresh one. */
  resumeSessionId?: string;
  /**
   * Text to surface in the run log as the user's message (chat resume).
   * Persisted as a server event with kind='user_message' so the log shows
   * what the user typed before Claude's response streams in.
   */
  displayUserMessage?: string;
  /** Per-run cost cap overrides. Defaults if unset. */
  costWarnUsd?: number;
  costKillUsd?: number;
  /** --permission-mode passed to the Claude CLI. Default 'acceptEdits'. */
  permissionMode?: "acceptEdits" | "bypassPermissions";
};

const KILL_GRACE_MS = 5000;

/**
 * Fork a `claude` subprocess for one lane run. Streams stream-json events to
 * the DB (as `messages` rows) and to subscribers on the run's EventEmitter.
 *
 * Returns once the spawn has been registered. The child runs to completion
 * in the background; observers attach via SSE on /api/runs/:id/stream.
 */
export function spawnAgent(p: SpawnAgentParams): void {
  const args: string[] = [
    "-oL",
    "-eL",
    "claude",
    "-p",
    p.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    p.permissionMode ?? "acceptEdits",
    "--model",
    p.model,
  ];
  if (p.resumeSessionId) {
    args.push("--resume", p.resumeSessionId);
  } else {
    args.push("--session-id", p.sessionId);
  }

  // Minimised env — explicit allow-list. Critical: do NOT spread process.env
  // (would leak SLACK_WEBHOOK, GH_TOKEN, etc. into Claude's reach via Bash
  // tool calls).
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? p.worktreePath,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    USER: process.env.USER ?? "",
    TERM: "xterm-256color",
  };
  // Pass through Anthropic creds if explicitly set; otherwise rely on the
  // user's logged-in `claude` CLI session (~/.claude/).
  if (process.env.ANTHROPIC_API_KEY) childEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  // The `as const` on stdio narrows the spawn overload so child.stdout / .stderr
  // are typed as Readable (not nullable).
  const child = spawn("stdbuf", args, {
    cwd: p.worktreePath,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"] as const,
    detached: false,
  });

  // Stable process title so a future reconciler can pkill orphans by pattern.
  try {
    process.title = process.title; // no-op; child.title is set via argv0 only — leave for now
  } catch {
    // ignore
  }

  const bus = getRunBus(p.runId);
  const startedAt = Date.now();

  let lastStopReason: StopReason | undefined;
  // If the final `result` event's text starts with NEEDS_INPUT:, stash
  // the question here so finalize() can set status='awaiting_input'.
  let needsInputQuestion: string | undefined;
  const stop = (reason: StopReason): void => {
    if (child.killed) return;
    lastStopReason = reason;
    audit({ action: "run.stop_requested", runId: p.runId, payload: { reason } });
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, KILL_GRACE_MS).unref();
  };

  runRegistry.set(p.runId, {
    runId: p.runId,
    taskId: p.taskId,
    child,
    startedAt,
    stop,
  });

  initMeter(p.runId, p.model, {
    warnUsd: p.costWarnUsd,
    killUsd: p.costKillUsd,
  });

  // Prepared statements — hot-path inserts.
  const insertMsg = sqlite.prepare(
    `INSERT INTO messages (run_id, seq, type, payload_json, created_at)
     VALUES (?, COALESCE((SELECT MAX(seq) FROM messages WHERE run_id = ?), 0) + 1, ?, ?, ?)
     RETURNING seq`,
  );
  const heartbeat = sqlite.prepare(`UPDATE runs SET last_heartbeat_at = ? WHERE id = ?`);

  const persistAndEmit = (
    type: RunEvent["type"],
    payload: unknown,
  ): void => {
    try {
      const row = insertMsg.get(p.runId, p.runId, type, JSON.stringify(payload), Date.now()) as
        | { seq: number }
        | undefined;
      const seq = row?.seq ?? 0;
      heartbeat.run(Date.now(), p.runId);
      bus.emit("event", { seq, type, payload } satisfies RunEvent);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[spawnAgent] persist failed", { runId: p.runId, err });
    }
  };

  // If this run is a chat resume, surface the user's message as the first
  // event in the log. Claude receives the same text via `-p "<text>"` but
  // never echoes it back, so the UI would otherwise start with Claude's
  // response and look like nothing was said.
  if (p.displayUserMessage) {
    persistAndEmit("server", { kind: "user_message", text: p.displayUserMessage });
  }

  // Synthesise a 'server' event so the client sees that the run started even
  // before Claude emits its first 'system init' frame.
  persistAndEmit("server", { kind: "spawned", model: p.model, worktree: p.worktreePath });

  const rl = readline.createInterface({ input: child.stdout!, terminal: false });
  rl.on("line", (line) => {
    const ev = parseStreamLine(line);
    if (!ev) return;

    // Capture the real Claude session_id from the system init frame (in case
    // it differs from the one we passed via --session-id).
    if (ev.type === "system" && ev.hint?.sessionId) {
      try {
        db.update(runs)
          .set({ claudeSessionId: ev.hint.sessionId })
          .where(eq(runs.id, p.runId))
          .run();
      } catch {
        // ignore
      }
    }

    persistAndEmit(ev.type as RunEvent["type"], ev.payload);

    // Mid-stream NEEDS_INPUT: the agent embedded a pause marker in an
    // assistant text block (typical for Interactive mode where the agent
    // asks permission before each Bash). Flip the run to awaiting_input
    // now and gracefully stop the subprocess so the user can reply via
    // chat without waiting for the whole run to finish.
    if (
      ev.type === "assistant" &&
      ev.hint?.needsInputQuestion &&
      !needsInputQuestion
    ) {
      needsInputQuestion = ev.hint.needsInputQuestion;
      persistAndEmit("server", {
        kind: "needs_input",
        question: needsInputQuestion,
      });
      // Flip status immediately so a UI refresh unlocks the ChatBox
      // without waiting for the subprocess to exit.
      try {
        db.update(runs)
          .set({ status: "awaiting_input" })
          .where(eq(runs.id, p.runId))
          .run();
      } catch {
        // ignore
      }
      // SIGTERM the child; finalize will keep status='awaiting_input'
      // because needsInputQuestion is set.
      stop("user");
    }

    // Cost meter — observe assistant usage blocks, may warn or hard-kill.
    if (ev.type === "assistant") {
      const usage = (ev.payload as { message?: { usage?: unknown } }).message?.usage as
        | Record<string, number>
        | undefined;
      if (usage) {
        const outcome = observeAssistantUsage(p.runId, usage);
        if (outcome.kind === "warn") {
          persistAndEmit("server", {
            kind: "cost_warn",
            usdCumulative: outcome.usdCumulative,
            threshold: outcome.threshold,
          });
        } else if (outcome.kind === "kill") {
          persistAndEmit("server", {
            kind: "cost_killed",
            usdCumulative: outcome.usdCumulative,
            threshold: outcome.threshold,
          });
          stop("cost_cap");
        } else {
          // Emit periodic cost ticks so the UI CostBadge can update live.
          persistAndEmit("server", {
            kind: "cost_tick",
            usdCumulative: outcome.usdCumulative,
          });
        }
      }
    }

    if (ev.type === "result" && ev.hint) {
      try {
        db.update(runs)
          .set({ numTurns: ev.hint.finalTurns ?? 0 })
          .where(eq(runs.id, p.runId))
          .run();
      } catch {
        // ignore
      }
      if (typeof ev.hint.finalCostUsd === "number") {
        finalizeMeter(p.runId, ev.hint.finalCostUsd);
      } else {
        clearMeter(p.runId);
      }

      // NEEDS_INPUT: stash the question for finalize() to pick up.
      if (ev.hint.needsInputQuestion) {
        needsInputQuestion = ev.hint.needsInputQuestion;
        persistAndEmit("server", {
          kind: "needs_input",
          question: ev.hint.needsInputQuestion,
        });
      }
    }
  });

  // Surface stderr as `server` events so they're visible in the UI without
  // killing the run (Claude often writes warnings to stderr).
  if (child.stderr) {
    const rlErr = readline.createInterface({ input: child.stderr, terminal: false });
    rlErr.on("line", (line) => {
      if (!line.trim()) return;
      persistAndEmit("server", { kind: "stderr", line: line.slice(0, 500) });
    });
  }

  child.on("error", (err) => {
    persistAndEmit("server", { kind: "spawn_error", error: String(err) });
    void finalize(p.runId, "failed", `spawn_error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    persistAndEmit("server", { kind: "exit", code, signal });
    let status = decideExitStatus(code, signal, lastStopReason);
    // NEEDS_INPUT: agent signalled a clarification request. Override
    // completed/stopped → awaiting_input so the UI shows the chat-to-
    // answer flow instead of a terminal state. (stopped is what we land
    // on if NEEDS_INPUT was mid-stream and we SIGTERM'd; completed is
    // what we land on if NEEDS_INPUT was in the final result text.)
    if (needsInputQuestion && (status === "completed" || status === "stopped")) {
      status = "awaiting_input";
    }
    const reasonTag = lastStopReason ? `${lastStopReason}:` : "";
    void finalize(
      p.runId,
      status,
      `${reasonTag}exit code=${code} signal=${signal ?? "none"}`,
    );
  });

  audit({ action: "run.started", runId: p.runId, taskId: p.taskId, payload: { model: p.model } });
  void sql; // silence unused-import in some configs
}

function decideExitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
  stopReason?: StopReason,
): "completed" | "failed" | "stopped" | "cost_killed" | "awaiting_input" {
  if (stopReason === "cost_cap") return "cost_killed";
  if (signal === "SIGTERM" || signal === "SIGKILL") return "stopped";
  if (code === 0) return "completed";
  return "failed";
}

async function finalize(
  runId: string,
  status:
    | "completed"
    | "failed"
    | "stopped"
    | "cost_killed"
    | "interrupted"
    | "awaiting_input",
  reason: string,
): Promise<void> {
  const handle = runRegistry.get(runId);
  if (handle) runRegistry.delete(runId);
  clearMeter(runId);

  try {
    // Always set killedReason explicitly so a row that was transiently
    // marked 'interrupted' by a bad reconciler run gets cleaned up when
    // its subprocess finishes naturally.
    const killedReason =
      status === "completed" || status === "awaiting_input"
        ? null
        : status === "failed" || status === "stopped" || status === "cost_killed"
          ? reason
          : null;
    db.update(runs)
      .set({ status, finishedAt: new Date(), killedReason })
      .where(eq(runs.id, runId))
      .run();

    // Implement lane rollback: if an Implement run ended without
    // completing (stopped / failed / cost-killed / interrupted), roll
    // the task's current_lane back to 'pr' so the board reflects the
    // last known-good state. The PR still exists + the approved
    // artifacts are intact; only the in-flight implementation work
    // was aborted.
    const didNotComplete =
      status === "stopped" ||
      status === "failed" ||
      status === "cost_killed" ||
      status === "interrupted";
    if (didNotComplete) {
      const row = db
        .select({ taskId: runs.taskId, lane: runs.lane })
        .from(runs)
        .where(eq(runs.id, runId))
        .get();
      if (row?.lane === "implement") {
        db.update(tasks)
          .set({ currentLane: "pr", currentRunId: null, updatedAt: new Date() })
          .where(eq(tasks.id, row.taskId))
          .run();
        audit({
          action: "task.lane_rolled_back",
          taskId: row.taskId,
          runId,
          payload: { from: "implement", to: "pr", reason: status },
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[spawnAgent] finalize update failed", { runId, err });
  }

  // Emit one last bus event so any connected SSE clients can show the
  // finalised state, then keep the bus alive briefly for late subscribers
  // (replay covers anything missed).
  const bus = getRunBus(runId);
  bus.emit("end", { type: "end", status, reason });
  setTimeout(() => closeRunBus(runId), 5000).unref();

  audit({ action: "run.finalized", runId, payload: { status, reason } });

  // On clean completion: persist the produced artifact, post any
  // milestone Jira comments, then auto-advance to the next lane.
  // Artifact persistence happens first so downstream readers pick up the
  // fresh file via priorArtifacts.
  if (status === "completed") {
    try {
      const { persistArtifactsForRun } = await import("./persistArtifacts");
      await persistArtifactsForRun(runId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[spawnAgent] artifact persistence failed", { runId, err });
    }

    // If this run was a Plan amendment (user clicked "Amend Plan from
    // Review"), post a follow-up Jira comment summarising what changed
    // so stakeholders see the iteration in the ticket.
    try {
      const { wasAmendmentRun, postAmendmentComment } = await import(
        "@/server/jira/amendComment"
      );
      if (wasAmendmentRun(runId)) {
        const run = db
          .select({ taskId: runs.taskId })
          .from(runs)
          .where(eq(runs.id, runId))
          .get();
        if (run) await postAmendmentComment(runId, run.taskId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[spawnAgent] amend comment failed", { runId, err });
    }

    try {
      const { maybeAutoAdvance } = await import("./autoAdvance");
      await maybeAutoAdvance(runId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[spawnAgent] auto-advance dispatch failed", { runId, err });
    }
  }
}
