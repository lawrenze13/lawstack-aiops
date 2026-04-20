"use client";

import { useEffect, useMemo, useReducer, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ─── Types ─────────────────────────────────────────────────────────────────

type EventRow = {
  seq: number;
  type:
    | "system"
    | "assistant"
    | "user"
    | "stream_event"
    | "result"
    | "server"
    | "end";
  payload: unknown;
};

type ToolResult = {
  toolUseId: string;
  content: string;
  isError: boolean;
};

type State = {
  events: EventRow[];
  ended: { status: string; reason: string | null } | null;
  connected: boolean;
  costUsd: number;
  costState: "ok" | "warn" | "kill";
  phase: "initial" | "replay" | "live" | "archived";
  /** tool_use.id → its paired tool_result */
  toolResults: Record<string, ToolResult>;
  /** message.id → output_tokens reported in usage. Sum = total output tokens. */
  outputTokensByMessage: Record<string, number>;
};

type Action =
  | { kind: "event"; row: EventRow }
  | { kind: "end"; status: string; reason: string | null }
  | { kind: "connected"; on: boolean }
  | { kind: "phase"; phase: State["phase"] };

// ─── Reducer ───────────────────────────────────────────────────────────────

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "event": {
      if (state.events.some((e) => e.seq === action.row.seq)) return state;

      let next = { ...state, events: [...state.events, action.row] };

      // Pull cost updates from server events / result.
      if (action.row.type === "server") {
        const p = action.row.payload as { kind?: string; usdCumulative?: number };
        if (typeof p.usdCumulative === "number") next.costUsd = p.usdCumulative;
        if (p.kind === "cost_warn") next.costState = "warn";
        if (p.kind === "cost_killed") next.costState = "kill";
      } else if (action.row.type === "result") {
        const p = action.row.payload as { total_cost_usd?: number };
        if (typeof p.total_cost_usd === "number") next.costUsd = p.total_cost_usd;
      }

      // Track per-message output tokens so the live status line can show
      // the running total.
      if (action.row.type === "assistant") {
        const msg = (action.row.payload as { message?: { id?: string; usage?: { output_tokens?: number } } })
          .message;
        if (msg?.id && typeof msg.usage?.output_tokens === "number") {
          next.outputTokensByMessage = {
            ...state.outputTokensByMessage,
            [msg.id]: msg.usage.output_tokens,
          };
        }
      }

      // Index tool_results by tool_use_id so tool_use blocks can render them inline.
      if (action.row.type === "user") {
        const content =
          (action.row.payload as { message?: { content?: unknown[] } }).message?.content ?? [];
        const updates: Record<string, ToolResult> = {};
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          const x = b as {
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (x.type === "tool_result" && typeof x.tool_use_id === "string") {
            updates[x.tool_use_id] = {
              toolUseId: x.tool_use_id,
              content: stringifyToolContent(x.content),
              isError: !!x.is_error,
            };
          }
        }
        if (Object.keys(updates).length > 0) {
          next.toolResults = { ...state.toolResults, ...updates };
        }
      }

      return next;
    }
    case "end":
      return {
        ...state,
        ended: { status: action.status, reason: action.reason },
        phase: "archived",
      };
    case "connected":
      return { ...state, connected: action.on };
    case "phase":
      return { ...state, phase: action.phase };
  }
}

const initial: State = {
  events: [],
  ended: null,
  connected: false,
  costUsd: 0,
  costState: "ok",
  phase: "initial",
  toolResults: {},
  outputTokensByMessage: {},
};

// ─── Component ─────────────────────────────────────────────────────────────

type Props = {
  runId: string;
  initialStatus: string;
  initialCostUsd: number;
  /** ms since epoch when the run started; drives the live elapsed counter. */
  initialStartedAtMs: number;
  canControl: boolean;
};

export function RunLog({
  runId,
  initialStatus,
  initialCostUsd,
  initialStartedAtMs,
  canControl,
}: Props) {
  const [state, dispatch] = useReducer(reducer, {
    ...initial,
    costUsd: initialCostUsd,
  });
  const scroller = useRef<HTMLDivElement | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopPending, startStop] = useTransition();

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/stream`, { withCredentials: true });
    let replayIdleTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLive = () => {
      if (replayIdleTimer) clearTimeout(replayIdleTimer);
      replayIdleTimer = setTimeout(() => dispatch({ kind: "phase", phase: "live" }), 1000);
    };

    const handler = (type: EventRow["type"]) => (e: MessageEvent) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(e.data);
      } catch {
        payload = { raw: e.data };
      }
      const seq = Number(e.lastEventId) || 0;
      if (type === "end") {
        const p = payload as { status?: string; reason?: string | null };
        if (replayIdleTimer) clearTimeout(replayIdleTimer);
        dispatch({ kind: "end", status: p.status ?? "unknown", reason: p.reason ?? null });
        es.close();
        return;
      }
      dispatch({ kind: "event", row: { seq, type, payload } });
      scheduleLive();
    };

    for (const t of ["system", "assistant", "user", "stream_event", "result", "server", "end"] as const) {
      es.addEventListener(t, handler(t));
    }

    es.onopen = () => {
      dispatch({ kind: "connected", on: true });
      dispatch({ kind: "phase", phase: "replay" });
    };
    es.onerror = () => dispatch({ kind: "connected", on: false });

    return () => {
      if (replayIdleTimer) clearTimeout(replayIdleTimer);
      es.close();
    };
  }, [runId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.events.length]);

  const isRunning = !state.ended && initialStatus === "running";
  const displayStatus = state.ended
    ? state.ended.reason
      ? `${state.ended.status} · ${state.ended.reason}`
      : state.ended.status
    : state.phase === "replay"
      ? "replaying history"
      : state.connected
        ? "streaming"
        : "reconnecting";

  const dotClass = state.ended
    ? "bg-gray-400"
    : state.phase === "replay"
      ? "bg-blue-500"
      : state.connected
        ? "bg-green-500"
        : "bg-amber-500";
  const dotTitle = state.ended
    ? "archived"
    : state.phase === "replay"
      ? "replaying history"
      : state.connected
        ? "live"
        : "reconnecting";

  const stop = () => {
    setStopError(null);
    startStop(async () => {
      const res = await fetch(`/api/runs/${runId}/stop`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setStopError(body.message ?? `HTTP ${res.status}`);
      }
    });
  };

  // Derive turn count (one per assistant event).
  const turnCount = useMemo(
    () => state.events.filter((e) => e.type === "assistant").length,
    [state.events],
  );

  // Sum of output tokens across all assistant messages observed.
  const totalOutputTokens = useMemo(
    () => Object.values(state.outputTokensByMessage).reduce((a, b) => a + b, 0),
    [state.outputTokensByMessage],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 text-xs">
        <span className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${dotClass}`}
            title={dotTitle}
          />
          <span className="font-mono">run {runId.slice(0, 8)}</span>
          <span className="text-[color:var(--color-muted-foreground)]">turn {turnCount}</span>
          <CostBadge usd={state.costUsd} costState={state.costState} />
        </span>
        <span className="flex items-center gap-2">
          <span className="rounded bg-[color:var(--color-muted)] px-2 py-0.5 font-medium">
            {displayStatus}
          </span>
          {isRunning && canControl ? (
            <button
              type="button"
              onClick={stop}
              disabled={stopPending}
              className="rounded border border-red-500/40 px-2 py-0.5 text-red-700 hover:bg-red-500/10 disabled:opacity-50"
            >
              {stopPending ? "Stopping…" : "Stop"}
            </button>
          ) : null}
        </span>
      </div>

      {stopError ? (
        <div className="border-b border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-700">
          Stop failed: {stopError}
        </div>
      ) : null}

      {!isRunning && initialStatus !== "running" ? (
        <div className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 px-3 py-1 text-xs text-[color:var(--color-muted-foreground)]">
          📼 This run finished. The events below are a log of what happened — no new events are being generated.
        </div>
      ) : state.phase === "replay" ? (
        <div className="border-b border-blue-500/40 bg-blue-500/10 px-3 py-1 text-xs text-blue-900">
          📼 Replaying history from this run… new events will stream in after.
        </div>
      ) : null}

      {state.costState === "warn" && !state.ended ? (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-800">
          ⚠ Cost crossed ${state.costUsd.toFixed(2)} — hard-stop at $15.
        </div>
      ) : null}
      {state.costState === "kill" || state.ended?.status === "cost_killed" ? (
        <div className="border-b border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-700">
          ✘ Cost cap reached (${state.costUsd.toFixed(2)}). Run terminated.
        </div>
      ) : null}

      {isRunning && state.phase !== "replay" ? (
        <LiveStatusLine
          startedAtMs={initialStartedAtMs}
          outputTokens={totalOutputTokens}
          costUsd={state.costUsd}
        />
      ) : null}

      <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-3 text-xs leading-relaxed">
        {state.events.length === 0 ? (
          <p className="text-[color:var(--color-muted-foreground)]">Waiting for events…</p>
        ) : (
          <EventStream events={state.events} toolResults={state.toolResults} />
        )}
        {state.ended ? (
          <div className="mt-4 border-t border-dashed border-[color:var(--color-border)] pt-2 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            — end of log — {state.ended.status}
            {state.ended.reason ? ` (${state.ended.reason})` : ""}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Live status line (Claude CLI-style spinner) ───────────────────────────

const SPINNER_GLYPHS = ["✢", "✶", "✷", "✸", "✹", "✺", "✻", "✽"] as const;

const WORDS = [
  "Wibbling",
  "Percolating",
  "Ruminating",
  "Contemplating",
  "Synthesizing",
  "Reticulating",
  "Ingesting",
  "Conjuring",
  "Marinating",
  "Cogitating",
  "Pondering",
  "Hmming",
  "Tinkering",
  "Simmering",
  "Spelunking",
  "Brewing",
  "Untangling",
  "Weaving",
  "Orchestrating",
  "Finessing",
] as const;

function LiveStatusLine({
  startedAtMs,
  outputTokens,
  costUsd,
}: {
  startedAtMs: number;
  outputTokens: number;
  costUsd: number;
}) {
  const [tick, setTick] = useState(0);
  // Pick a word per "slot" (3s windows) so it stays stable for a few seconds.
  const wordIndex = Math.floor(tick / 20) % WORDS.length;
  const word = WORDS[wordIndex]!;
  const glyph = SPINNER_GLYPHS[tick % SPINNER_GLYPHS.length]!;

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 150);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const elapsed = formatElapsed(elapsedMs);
  const tokens = formatTokens(outputTokens);

  return (
    <div className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 px-3 py-1.5 font-mono text-[11px] text-[color:var(--color-foreground)]">
      <span className="text-blue-600">{glyph}</span>{" "}
      <span className="font-medium">{word}…</span>{" "}
      <span className="text-[color:var(--color-muted-foreground)]">
        ({elapsed} · ↓ {tokens} tokens · ${costUsd.toFixed(4)})
      </span>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// ─── Event stream renderer ─────────────────────────────────────────────────

function EventStream({
  events,
  toolResults,
}: {
  events: EventRow[];
  toolResults: Record<string, ToolResult>;
}) {
  let turnIndex = 0;
  return (
    <>
      {events.map((e) => {
        if (e.type === "assistant") {
          turnIndex++;
          return (
            <AssistantTurn
              key={e.seq}
              payload={e.payload}
              turn={turnIndex}
              toolResults={toolResults}
            />
          );
        }
        if (e.type === "system") return <SystemLine key={e.seq} payload={e.payload} />;
        if (e.type === "result") return <ResultLine key={e.seq} payload={e.payload} />;
        if (e.type === "server") return <ServerLine key={e.seq} payload={e.payload} />;
        // user events are rendered inline under their corresponding tool_use;
        // tool-level errors are handled there.
        return null;
      })}
    </>
  );
}

function AssistantTurn({
  payload,
  turn,
  toolResults,
}: {
  payload: unknown;
  turn: number;
  toolResults: Record<string, ToolResult>;
}) {
  const blocks = (payload as { message?: { content?: unknown[] } }).message?.content ?? [];
  const texts: string[] = [];
  const tools: Array<{ id: string; name: string; input: unknown }> = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const x = b as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (x.type === "text" && typeof x.text === "string") texts.push(x.text);
    if (x.type === "tool_use" && typeof x.name === "string" && typeof x.id === "string") {
      tools.push({ id: x.id, name: x.name, input: x.input });
    }
  }

  return (
    <div className="mb-4 border-l-2 border-[color:var(--color-border)] pl-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        ▸ assistant · turn {turn}
      </div>

      {texts.map((t, i) => (
        <div
          key={i}
          className="prose prose-sm mb-2 max-w-none text-[color:var(--color-foreground)] prose-pre:my-1 prose-pre:rounded prose-pre:bg-[color:var(--color-muted)] prose-pre:p-2 prose-pre:text-xs prose-code:text-xs prose-code:before:content-none prose-code:after:content-none"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{t}</ReactMarkdown>
        </div>
      ))}

      {tools.map((t) => (
        <ToolCall
          key={t.id}
          name={t.name}
          input={t.input}
          result={toolResults[t.id]}
        />
      ))}
    </div>
  );
}

function ToolCall({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result: ToolResult | undefined;
}) {
  const icon = toolIcon(name);
  const color = toolColor(name);
  const summary = summariseInput(name, input);
  const headerClass = `flex items-center gap-2 rounded border ${color} px-2 py-1`;
  const hasError = result?.isError;

  return (
    <details className="group mb-1.5">
      <summary className={`${headerClass} cursor-pointer list-none`}>
        <span className="text-xs">{icon}</span>
        <span className="font-mono text-[11px] font-medium">{name}</span>
        {summary ? (
          <span className="font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
            {summary}
          </span>
        ) : null}
        {hasError ? <span className="text-[11px] text-red-700">· error</span> : null}
        {!result ? (
          <span className="ml-auto animate-pulse text-[10px] text-[color:var(--color-muted-foreground)]">
            running…
          </span>
        ) : (
          <span className="ml-auto text-[10px] text-[color:var(--color-muted-foreground)] group-open:hidden">
            expand
          </span>
        )}
      </summary>

      <div className="ml-4 mt-1 space-y-1">
        {input && typeof input === "object" && !isEmptyObject(input) ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              input
            </div>
            <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-[color:var(--color-muted)]/60 p-2 font-mono text-[11px]">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
        ) : null}
        {result ? (
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              <span>result</span>
              {result.isError ? <span className="text-red-700">error</span> : null}
            </div>
            <pre
              className={`mt-0.5 max-h-64 overflow-auto rounded p-2 font-mono text-[11px] ${
                result.isError
                  ? "bg-red-500/10 text-red-900"
                  : "bg-[color:var(--color-muted)]/60"
              }`}
            >
              {truncate(result.content, 4000)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SystemLine({ payload }: { payload: unknown }) {
  const p = payload as { subtype?: string; model?: string };
  if (p.subtype !== "init") return null;
  return (
    <div className="mb-2 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
      ⚙ session started {p.model ? `· ${p.model}` : ""}
    </div>
  );
}

function ResultLine({ payload }: { payload: unknown }) {
  const p = payload as { total_cost_usd?: number; num_turns?: number; duration_ms?: number };
  const duration = typeof p.duration_ms === "number" ? `${Math.round(p.duration_ms / 1000)}s` : "";
  return (
    <div className="my-3 rounded border border-green-500/40 bg-green-500/10 px-3 py-2 font-mono text-[11px] text-green-900">
      ✓ result · {p.num_turns ?? 0} turn{p.num_turns === 1 ? "" : "s"} · $
      {(p.total_cost_usd ?? 0).toFixed(4)}
      {duration ? ` · ${duration}` : ""}
    </div>
  );
}

function ServerLine({ payload }: { payload: unknown }) {
  const p = payload as {
    kind?: string;
    line?: string;
    error?: string;
    code?: number;
    usdCumulative?: number;
  };
  if (p.kind === "cost_tick") return null;
  const content = (() => {
    switch (p.kind) {
      case "spawned":
        return "▶ spawned Claude subprocess";
      case "exit":
        return `⏹ subprocess exited (code=${p.code})`;
      case "spawn_error":
        return `✘ spawn error: ${p.error}`;
      case "stderr":
        return `stderr: ${p.line}`;
      case "parse_error":
        return "parse error";
      case "cost_warn":
        return `⚠ cost warning at $${(p.usdCumulative ?? 0).toFixed(2)}`;
      case "cost_killed":
        return `✘ cost cap at $${(p.usdCumulative ?? 0).toFixed(2)}`;
      default:
        return null;
    }
  })();
  if (!content) return null;
  return (
    <div className="mb-1 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
      {content}
    </div>
  );
}

// ─── Cost badge ────────────────────────────────────────────────────────────

function CostBadge({
  usd,
  costState,
}: {
  usd: number;
  costState: State["costState"];
}) {
  const cls =
    costState === "kill"
      ? "bg-red-500/15 text-red-700 border-red-500/40"
      : costState === "warn"
        ? "bg-amber-500/15 text-amber-800 border-amber-500/40"
        : "bg-[color:var(--color-muted)] text-[color:var(--color-muted-foreground)] border-[color:var(--color-border)]";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`}
      title="running cost"
    >
      ${usd.toFixed(4)}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function toolIcon(name: string): string {
  switch (name) {
    case "Read":
      return "📖";
    case "Write":
      return "✏️";
    case "Edit":
    case "MultiEdit":
      return "📝";
    case "Glob":
      return "🗂️";
    case "Grep":
      return "🔎";
    case "Bash":
      return "⚡";
    case "Task":
      return "🧠";
    case "WebFetch":
      return "🌐";
    case "TodoWrite":
      return "📋";
    default:
      return "🔧";
  }
}

function toolColor(name: string): string {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
      return "border-blue-500/30 bg-blue-500/5";
    case "Write":
    case "Edit":
    case "MultiEdit":
      return "border-orange-500/30 bg-orange-500/5";
    case "Bash":
      return "border-purple-500/30 bg-purple-500/5";
    case "Task":
      return "border-indigo-500/30 bg-indigo-500/5";
    case "WebFetch":
      return "border-cyan-500/30 bg-cyan-500/5";
    case "TodoWrite":
      return "border-emerald-500/30 bg-emerald-500/5";
    default:
      return "border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40";
  }
}

function summariseInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return String(i.file_path ?? "");
    case "Glob":
    case "Grep":
      return String(i.pattern ?? "");
    case "Bash":
      return String(i.command ?? "").slice(0, 120);
    case "WebFetch":
      return String(i.url ?? "");
    case "Task":
      return String(i.description ?? "");
    case "TodoWrite": {
      const todos = i.todos as unknown[] | undefined;
      return todos ? `${todos.length} todo${todos.length === 1 ? "" : "s"}` : "";
    }
    default:
      return "";
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Some content blocks come as [{type:'text', text:'...'}]
    const parts = content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: string }).text === "string" ? (b as { text: string }).text : null))
      .filter((t): t is string => t !== null);
    if (parts.length > 0) return parts.join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

function isEmptyObject(x: unknown): boolean {
  return !!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0;
}
