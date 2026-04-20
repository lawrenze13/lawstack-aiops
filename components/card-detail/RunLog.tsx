"use client";

import { useEffect, useReducer, useRef } from "react";

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
};

type Action =
  | { kind: "event"; row: EventRow }
  | { kind: "end"; status: string; reason: string | null }
  | { kind: "connected"; on: boolean };

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "event":
      // De-dupe by seq (replay-then-live can briefly overlap).
      if (state.events.some((e) => e.seq === action.row.seq)) return state;
      return { ...state, events: [...state.events, action.row] };
    case "end":
      return { ...state, ended: { status: action.status, reason: action.reason } };
    case "connected":
      return { ...state, connected: action.on };
  }
}

const initial: State = { events: [], ended: null, connected: false };

type Props = { runId: string };

export function RunLog({ runId }: Props) {
  const [state, dispatch] = useReducer(reducer, initial);
  const scroller = useRef<HTMLDivElement | null>(null);

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

  // Auto-scroll to bottom on new events.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.events.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 text-xs">
        <span className="font-mono">run {runId.slice(0, 8)}</span>
        <span className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${state.connected ? "bg-green-500" : "bg-amber-500"}`}
            title={state.connected ? "live" : "reconnecting"}
          />
          {state.ended ? (
            <span className="rounded bg-[color:var(--color-muted)] px-2 py-0.5 font-medium">
              {state.ended.status}
              {state.ended.reason ? ` · ${state.ended.reason}` : ""}
            </span>
          ) : (
            <span className="text-[color:var(--color-muted-foreground)]">streaming</span>
          )}
        </span>
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {state.events.length === 0 ? (
          <p className="text-[color:var(--color-muted-foreground)]">Waiting for events…</p>
        ) : (
          state.events.map((e) => <EventLine key={e.seq} ev={e} />)
        )}
      </div>
    </div>
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
              🔧 {t.name} {t.summary ? <span className="text-[color:var(--color-muted-foreground)]">{t.summary}</span> : null}
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
      const p = ev.payload as { kind?: string; line?: string; error?: string; code?: number };
      return (
        <div className="mb-1 text-[color:var(--color-muted-foreground)]">
          {p.kind === "spawned" && "▶ spawned"}
          {p.kind === "exit" && `⏹ exit code=${p.code}`}
          {p.kind === "spawn_error" && `✘ ${p.error}`}
          {p.kind === "stderr" && `stderr: ${p.line}`}
          {p.kind === "parse_error" && `parse error`}
        </div>
      );
    }
    case "stream_event":
      return null; // partial-message deltas; skip in v1
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
