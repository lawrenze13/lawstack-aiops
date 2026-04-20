"use client";

import { useEffect, useReducer, useRef, useState, useTransition } from "react";

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

type State = {
  events: EventRow[];
  ended: { status: string; reason: string | null } | null;
  connected: boolean;
  /** Running cost in USD from the server's cost_tick events. */
  costUsd: number;
  /** "warn" when $5 crossed, "kill" when $15 enforced. */
  costState: "ok" | "warn" | "kill";
};

type Action =
  | { kind: "event"; row: EventRow }
  | { kind: "end"; status: string; reason: string | null }
  | { kind: "connected"; on: boolean };

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "event": {
      if (state.events.some((e) => e.seq === action.row.seq)) return state;

      // Update cost from server cost_tick/warn/kill events.
      let next = { ...state, events: [...state.events, action.row] };
      if (action.row.type === "server") {
        const p = action.row.payload as {
          kind?: string;
          usdCumulative?: number;
        };
        if (typeof p.usdCumulative === "number") {
          next.costUsd = p.usdCumulative;
        }
        if (p.kind === "cost_warn") next.costState = "warn";
        if (p.kind === "cost_killed") next.costState = "kill";
      } else if (action.row.type === "result") {
        const p = action.row.payload as { total_cost_usd?: number };
        if (typeof p.total_cost_usd === "number") next.costUsd = p.total_cost_usd;
      }
      return next;
    }
    case "end":
      return { ...state, ended: { status: action.status, reason: action.reason } };
    case "connected":
      return { ...state, connected: action.on };
  }
}

const initial: State = {
  events: [],
  ended: null,
  connected: false,
  costUsd: 0,
  costState: "ok",
};

type Props = {
  runId: string;
  initialStatus: string;
  initialCostUsd: number;
  /** true when the viewer can stop the run (owner or admin). */
  canControl: boolean;
};

export function RunLog({ runId, initialStatus, initialCostUsd, canControl }: Props) {
  const [state, dispatch] = useReducer(reducer, {
    ...initial,
    costUsd: initialCostUsd,
  });
  const scroller = useRef<HTMLDivElement | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopPending, startStop] = useTransition();

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/stream`, { withCredentials: true });

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
        dispatch({ kind: "end", status: p.status ?? "unknown", reason: p.reason ?? null });
        return;
      }
      dispatch({ kind: "event", row: { seq, type, payload } });
    };

    for (const t of ["system", "assistant", "user", "stream_event", "result", "server", "end"] as const) {
      es.addEventListener(t, handler(t));
    }

    es.onopen = () => dispatch({ kind: "connected", on: true });
    es.onerror = () => dispatch({ kind: "connected", on: false });

    return () => es.close();
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
    : state.connected
      ? "streaming"
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 text-xs">
        <span className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${state.connected ? "bg-green-500" : "bg-amber-500"}`}
            title={state.connected ? "live" : "reconnecting"}
          />
          <span className="font-mono">run {runId.slice(0, 8)}</span>
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

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {state.events.length === 0 ? (
          <p className="text-[color:var(--color-muted-foreground)]">Waiting for events…</p>
        ) : (
          state.events.map((e) => <EventLine key={e.seq} ev={e} />)
        )}
      </div>
    </div>
  );
}

function CostBadge({ usd, costState }: { usd: number; costState: State["costState"] }) {
  const cls =
    costState === "kill"
      ? "bg-red-500/15 text-red-700 border-red-500/40"
      : costState === "warn"
        ? "bg-amber-500/15 text-amber-800 border-amber-500/40"
        : "bg-[color:var(--color-muted)] text-[color:var(--color-muted-foreground)] border-[color:var(--color-border)]";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`} title="running cost">
      ${usd.toFixed(4)}
    </span>
  );
}

function EventLine({ ev }: { ev: EventRow }) {
  switch (ev.type) {
    case "system": {
      const p = ev.payload as { subtype?: string; model?: string };
      return (
        <div className="mb-1 text-[color:var(--color-muted-foreground)]">
          <span className="text-purple-600">⚙ system</span>{" "}
          {p.subtype ? `[${p.subtype}]` : ""} {p.model ? `model=${p.model}` : ""}
        </div>
      );
    }
    case "assistant": {
      const blocks = (ev.payload as { message?: { content?: unknown[] } }).message?.content ?? [];
      const texts: string[] = [];
      const tools: Array<{ name: string; summary: string }> = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        const x = b as { type?: string; text?: string; name?: string; input?: unknown };
        if (x.type === "text" && typeof x.text === "string") texts.push(x.text);
        if (x.type === "tool_use" && typeof x.name === "string") {
          tools.push({ name: x.name, summary: summariseInput(x.name, x.input) });
        }
      }
      return (
        <div className="mb-2">
          {texts.map((t, i) => (
            <pre
              key={i}
              className="whitespace-pre-wrap rounded bg-[color:var(--color-muted)]/40 px-2 py-1 text-[color:var(--color-foreground)]"
            >
              {t}
            </pre>
          ))}
          {tools.map((t, i) => (
            <div key={i} className="mt-1 text-blue-700">
              🔧 {t.name}{" "}
              {t.summary ? (
                <span className="text-[color:var(--color-muted-foreground)]">{t.summary}</span>
              ) : null}
            </div>
          ))}
        </div>
      );
    }
    case "user": {
      const p = ev.payload as { message?: { content?: unknown[] } };
      const errored = (p.message?.content ?? []).some(
        (b) => b && typeof b === "object" && (b as { is_error?: boolean }).is_error === true,
      );
      if (!errored) return null;
      return <div className="mb-1 text-amber-700">⚠ tool error</div>;
    }
    case "result": {
      const p = ev.payload as { total_cost_usd?: number; num_turns?: number };
      return (
        <div className="mt-2 rounded border border-green-500/40 bg-green-500/10 px-2 py-1">
          ✓ result · turns={p.num_turns ?? 0} · cost=${(p.total_cost_usd ?? 0).toFixed(4)}
        </div>
      );
    }
    case "server": {
      const p = ev.payload as {
        kind?: string;
        line?: string;
        error?: string;
        code?: number;
        usdCumulative?: number;
      };
      if (p.kind === "cost_tick") return null; // don't spam the log; cost is shown in the badge
      return (
        <div className="mb-1 text-[color:var(--color-muted-foreground)]">
          {p.kind === "spawned" && "▶ spawned"}
          {p.kind === "exit" && `⏹ exit code=${p.code}`}
          {p.kind === "spawn_error" && `✘ ${p.error}`}
          {p.kind === "stderr" && `stderr: ${p.line}`}
          {p.kind === "parse_error" && `parse error`}
          {p.kind === "cost_warn" && `⚠ cost warning at $${(p.usdCumulative ?? 0).toFixed(2)}`}
          {p.kind === "cost_killed" && `✘ cost cap at $${(p.usdCumulative ?? 0).toFixed(2)}`}
        </div>
      );
    }
    case "stream_event":
      return null;
    default:
      return null;
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
    default:
      return "";
  }
}
