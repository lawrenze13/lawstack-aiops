"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

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

type DiffFile = {
  /** Element id for scroll target. */
  id: string;
  /** Full path as it appears in `diff --git a/<path> b/<path>` */
  path: string;
  /** Best-effort basename for sidebar display. */
  basename: string;
  /** Directory portion (without basename). */
  dir: string;
  status: "added" | "deleted" | "modified" | "renamed" | "unchanged";
  insertions: number;
  deletions: number;
  /** Line range in the raw diff — startLine (inclusive) through endLine (exclusive). */
  startLine: number;
  endLine: number;
};

/**
 * Fetches the feature branch's diff against origin/main and renders it
 * with a left sidebar of changed files + a scrollable diff pane.
 */
export function ChangesViewer({ taskId }: Props) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState("");
  const diffPaneRef = useRef<HTMLDivElement | null>(null);

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

  const { files, lines } = useMemo(() => {
    if (!data || !data.hasWorktree) return { files: [], lines: [] as string[] };
    return parseDiff(data.diff);
  }, [data]);

  const filteredFiles = useMemo(() => {
    if (!filter.trim()) return files;
    const f = filter.trim().toLowerCase();
    return files.filter((file) => file.path.toLowerCase().includes(f));
  }, [files, filter]);

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

  const scrollToFile = (fileId: string) => {
    const pane = diffPaneRef.current;
    if (!pane) return;
    const el = pane.querySelector<HTMLElement>(`#${CSS.escape(fileId)}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

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
            <Chip color="warning" variant="soft" size="sm">
              truncated
            </Chip>
          ) : null}
        </div>
        <Button
          {...BUTTON_INTENTS["neutral-secondary"]}
          size="sm"
          onPress={() => setRefreshKey((k) => k + 1)}
        >
          Refresh
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* File list sidebar */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20">
          <div className="border-b border-[color:var(--color-border)] p-2">
            <input
              type="text"
              placeholder={`Filter ${files.length} file${files.length === 1 ? "" : "s"}…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-1 text-xs placeholder:text-[color:var(--color-muted-foreground)]"
            />
          </div>
          <ul className="flex-1 overflow-y-auto">
            {filteredFiles.length === 0 ? (
              <li className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                No files match.
              </li>
            ) : (
              filteredFiles.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => scrollToFile(file.id)}
                    className="flex w-full items-start gap-2 border-b border-[color:var(--color-border)] px-3 py-1.5 text-left hover:bg-[color:var(--color-muted)]/60"
                  >
                    <StatusDot status={file.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] font-medium">
                        {file.basename}
                      </span>
                      {file.dir ? (
                        <span className="block truncate font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
                          {file.dir}/
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-mono text-[10px]">
                      {file.insertions > 0 ? (
                        <span className="text-green-700">+{file.insertions}</span>
                      ) : null}
                      {file.insertions > 0 && file.deletions > 0 ? " " : ""}
                      {file.deletions > 0 ? (
                        <span className="text-red-700">-{file.deletions}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* Diff pane */}
        <div
          ref={diffPaneRef}
          className="flex-1 overflow-y-auto bg-[color:var(--color-background)]"
        >
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

            <DiffBody files={files} lines={lines} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: DiffFile["status"] }) {
  const { cls, letter, title } = (() => {
    switch (status) {
      case "added":
        return { cls: "bg-green-500", letter: "A", title: "added" };
      case "deleted":
        return { cls: "bg-red-500", letter: "D", title: "deleted" };
      case "renamed":
        return { cls: "bg-blue-500", letter: "R", title: "renamed" };
      case "modified":
      default:
        return { cls: "bg-amber-500", letter: "M", title: "modified" };
    }
  })();
  return (
    <span
      className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold text-white ${cls}`}
      title={title}
    >
      {letter}
    </span>
  );
}

function DiffBody({ files, lines }: { files: DiffFile[]; lines: string[] }) {
  if (files.length === 0) {
    // Fallback: render the whole thing as one block when parsing found no
    // file boundaries (shouldn't happen for a normal diff).
    return (
      <pre className="overflow-x-auto rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] p-3 font-mono text-[11px] leading-snug">
        {lines.map((line, i) => {
          const cls = classifyDiffLine(line);
          return (
            <span key={i} className={`block whitespace-pre ${cls}`}>
              {line || " "}
            </span>
          );
        })}
      </pre>
    );
  }

  return (
    <div className="space-y-4">
      {files.map((file) => (
        <section
          key={file.id}
          id={file.id}
          className="scroll-mt-4 overflow-hidden rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)]"
        >
          <header className="flex items-center gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 px-3 py-1.5">
            <StatusDot status={file.status} />
            <span className="flex-1 truncate font-mono text-[11px] font-medium">
              {file.path}
            </span>
            <span className="shrink-0 font-mono text-[10px]">
              {file.insertions > 0 ? (
                <span className="text-green-700">+{file.insertions}</span>
              ) : null}
              {file.insertions > 0 && file.deletions > 0 ? " " : ""}
              {file.deletions > 0 ? (
                <span className="text-red-700">-{file.deletions}</span>
              ) : null}
            </span>
          </header>
          <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-snug">
            {lines.slice(file.startLine, file.endLine).map((line, i) => {
              const cls = classifyDiffLine(line);
              return (
                <span key={i} className={`block whitespace-pre ${cls}`}>
                  {line || " "}
                </span>
              );
            })}
          </pre>
        </section>
      ))}
    </div>
  );
}

function classifyDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-[color:var(--color-muted-foreground)] font-semibold";
  }
  if (line.startsWith("@@")) {
    return "text-blue-700 bg-blue-500/5";
  }
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("Binary files")) {
    return "text-[color:var(--color-muted-foreground)] font-semibold";
  }
  if (line.startsWith("+")) {
    return "text-green-700 bg-green-500/5";
  }
  if (line.startsWith("-")) {
    return "text-red-700 bg-red-500/5";
  }
  return "text-[color:var(--color-foreground)]";
}

// ─── Diff parser ─────────────────────────────────────────────────────────

function parseDiff(diff: string): { files: DiffFile[]; lines: string[] } {
  const lines = diff.split("\n");
  const files: DiffFile[] = [];

  let current: DiffFile | null = null;
  let usedIds = new Set<string>();

  const pushCurrent = (endLine: number) => {
    if (!current) return;
    current.endLine = endLine;
    files.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      pushCurrent(i);
      // "diff --git a/<path> b/<path>" — take the 'b/' path.
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match?.[2] ?? match?.[1] ?? "(unknown)";
      const { basename, dir } = splitPath(path);
      const id = makeUniqueId(pathToId(path), usedIds);
      current = {
        id,
        path,
        basename,
        dir,
        status: "modified",
        insertions: 0,
        deletions: 0,
        startLine: i,
        endLine: i,
      };
      continue;
    }
    if (!current) continue;

    // Status signals
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from") || line.startsWith("rename to"))
      current.status = "renamed";

    // Count insertions/deletions. Skip the `+++`/`---` file headers.
    if (line.startsWith("+") && !line.startsWith("+++")) current.insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
  }
  pushCurrent(lines.length);

  return { files, lines };
}

function splitPath(path: string): { basename: string; dir: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { basename: path, dir: "" };
  return { basename: path.slice(idx + 1), dir: path.slice(0, idx) };
}

function pathToId(path: string): string {
  return "diff-file-" + path.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function makeUniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  used.add(id);
  return id;
}
