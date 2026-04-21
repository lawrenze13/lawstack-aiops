"use client";

import { useEffect, useState } from "react";

type DiffResponse =
  | {
      hasWorktree: false;
      diff: "";
      stat: "";
      commits: [];
      branch: null;
    }
  | {
      hasWorktree: true;
      branch: string;
      commits: Array<{ sha: string; subject: string }>;
      stat: string;
      diff: string;
      truncated: boolean;
    };

type Props = {
  taskId: string;
};

/**
 * Fetches the feature branch's diff against origin/main and renders it
 * with basic line-level colouring (green +, red -, blue @@).
 */
export function ChangesViewer({ taskId }: Props) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    fetch(`/api/tasks/${taskId}/diff`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { message?: string };
          throw new Error(j.message ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((j: DiffResponse) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (err) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-red-700">
        Diff failed: {err}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-[color:var(--color-muted-foreground)]">
        Loading diff…
      </div>
    );
  }
  if (!data.hasWorktree) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-[color:var(--color-muted-foreground)]">
        No worktree for this task — start a run to create one.
      </div>
    );
  }
  if (data.commits.length === 0 && data.diff.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-[color:var(--color-muted-foreground)]">
        No commits yet on <span className="mx-1 font-mono">{data.branch}</span> vs main.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-2">
        <div className="flex items-center gap-3 text-xs">
          <span className="font-mono text-[color:var(--color-muted-foreground)]">
            {data.branch} ↔ main
          </span>
          {data.stat ? (
            <span className="text-[color:var(--color-muted-foreground)]">{data.stat}</span>
          ) : null}
          <span className="text-[color:var(--color-muted-foreground)]">
            {data.commits.length} commit{data.commits.length === 1 ? "" : "s"}
          </span>
          {data.truncated ? (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-800">
              truncated
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] hover:bg-[color:var(--color-muted)]"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-[color:var(--color-background)]">
        <div className="mx-auto max-w-6xl px-4 py-4">
          {data.commits.length > 0 ? (
            <details className="mb-3 rounded border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40">
              <summary className="cursor-pointer px-3 py-1.5 text-xs font-semibold">
                Commits ({data.commits.length})
              </summary>
              <ul className="border-t border-[color:var(--color-border)] p-2">
                {data.commits.map((c, i) => (
                  <li key={c.sha + i} className="flex gap-3 py-0.5 text-xs">
                    <code className="text-[color:var(--color-muted-foreground)]">{c.sha}</code>
                    <span>{c.subject}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <DiffBody diff={data.diff} />
        </div>
      </div>
    </div>
  );
}

function DiffBody({ diff }: { diff: string }) {
  // Render line-by-line with simple classification so long diffs don't
  // overwhelm the DOM. Each line gets a CSS class based on its first char.
  const lines = diff.split("\n");
  return (
    <pre className="overflow-x-auto rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] p-3 font-mono text-[11px] leading-snug">
      {lines.map((line, i) => {
        const cls = classifyDiffLine(line);
        return (
          <span key={i} className={`block whitespace-pre ${cls}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

function classifyDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-[color:var(--color-muted-foreground)] font-semibold";
  }
  if (line.startsWith("@@")) {
    return "text-blue-700 bg-blue-500/5";
  }
  if (line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-[color:var(--color-muted-foreground)] font-semibold mt-2 pt-1 border-t border-[color:var(--color-border)]";
  }
  if (line.startsWith("+")) {
    return "text-green-700 bg-green-500/5";
  }
  if (line.startsWith("-")) {
    return "text-red-700 bg-red-500/5";
  }
  return "text-[color:var(--color-foreground)]";
}
