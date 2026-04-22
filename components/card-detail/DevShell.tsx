"use client";

import { useEffect, useRef, useState, useTransition } from "react";

type ShellResponse = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
};

type HistoryEntry = ShellResponse & {
  ts: number;
};

type Props = {
  taskId: string;
  canControl: boolean;
  cwd: string;
};

// Quick-actions for common Yii2 dev tasks. Just typed into the input on
// click — operator can edit before running.
const QUICK_ACTIONS: Array<{ label: string; cmd: string }> = [
  { label: "git status", cmd: "git status" },
  { label: "git log (recent)", cmd: "git log --oneline -10" },
  { label: "clear cache", cmd: "rm -rf runtime/cache && echo cleared" },
  { label: "composer install", cmd: "composer install --no-interaction" },
  { label: "yii migrate", cmd: "php yii migrate --interactive=0" },
  { label: "yii cache/flush-all", cmd: "php yii cache/flush-all" },
];

export function DevShell({ taskId, canControl, cwd }: Props) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cmdHistoryIndex, setCmdHistoryIndex] = useState<number>(-1);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [history.length]);

  const run = (command: string) => {
    const c = command.trim();
    if (!c) return;
    setError(null);
    setCmdHistoryIndex(-1);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/preview-shell`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: c }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setError(j.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ShellResponse;
      setHistory((h) => [...h, { ...data, ts: Date.now() }]);
      setInput("");
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(input);
      return;
    }
    if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      const next = Math.min(
        cmdHistoryIndex === -1 ? history.length - 1 : cmdHistoryIndex - 1,
        history.length - 1,
      );
      if (next < 0) return;
      setCmdHistoryIndex(next);
      setInput(history[next]!.command);
    } else if (e.key === "ArrowDown") {
      if (cmdHistoryIndex === -1) return;
      e.preventDefault();
      const next = cmdHistoryIndex + 1;
      if (next >= history.length) {
        setCmdHistoryIndex(-1);
        setInput("");
      } else {
        setCmdHistoryIndex(next);
        setInput(history[next]!.command);
      }
    }
  };

  if (!canControl) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-[color:var(--color-muted-foreground)]">
        Dev shell is owner/admin only.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black text-green-400">
      <div className="flex items-center justify-between border-b border-green-900/50 px-3 py-1.5 text-[10px]">
        <span className="font-mono">
          <span className="text-green-600">$</span> shell · cwd={" "}
          <span className="text-green-300">{cwd}</span>
        </span>
        <button
          type="button"
          onClick={() => setHistory([])}
          className="rounded border border-green-900/50 px-2 py-0.5 hover:bg-green-900/20"
          title="Clear visible history (doesn't undo anything that ran)"
        >
          clear
        </button>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-green-900/50 px-3 py-1.5">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => setInput(a.cmd)}
            disabled={pending}
            className="rounded border border-green-900/50 px-2 py-0.5 text-[10px] font-mono hover:bg-green-900/20 disabled:opacity-50"
            title={a.cmd}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-tight"
      >
        {history.length === 0 ? (
          <div className="px-3 py-2 text-green-700">
            Type a command below. ↑/↓ cycles history. 30s timeout, 256KB output cap.
          </div>
        ) : (
          history.map((h, i) => (
            <div key={i} className="border-b border-green-900/20 px-3 py-1.5">
              <div className="text-green-300">
                <span className="text-green-600">$</span> {h.command}
                <span className="ml-2 text-[10px] text-green-800">
                  (exit {h.exitCode} · {h.durationMs}ms
                  {h.truncated ? " · truncated" : ""})
                </span>
              </div>
              {h.stdout ? (
                <pre className="mt-0.5 whitespace-pre-wrap text-green-400">
                  {h.stdout}
                </pre>
              ) : null}
              {h.stderr ? (
                <pre className="mt-0.5 whitespace-pre-wrap text-red-400">
                  {h.stderr}
                </pre>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-green-900/50 px-3 py-1.5">
        {error ? (
          <div className="mb-1 text-[11px] text-red-400">× {error}</div>
        ) : null}
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className="text-green-600">$</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={pending}
            placeholder={pending ? "running…" : "type a command and press Enter"}
            className="flex-1 bg-transparent outline-none placeholder:text-green-800 disabled:opacity-50"
            autoFocus
          />
          <button
            type="button"
            onClick={() => run(input)}
            disabled={pending || !input.trim()}
            className="rounded border border-green-900/50 px-2 py-0.5 text-[10px] hover:bg-green-900/20 disabled:opacity-50"
          >
            {pending ? "…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
