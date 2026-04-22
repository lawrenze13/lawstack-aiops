/**
 * Server-render skeleton shown by Next.js while `page.tsx`'s DB queries
 * run (allRuns, threadEvents, artifacts, audit log, pr_records, etc.
 * add up to ~300-500ms on a cold card). Matches the real layout closely
 * enough that the transition from skeleton → page doesn't reflow.
 */
export default function CardLoading() {
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="h-4 w-24 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
          <div className="h-4 w-64 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-7 w-20 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
          <div className="h-7 w-32 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
        </div>
      </header>

      <section className="grid flex-1 min-h-0 grid-cols-12 gap-4 p-4">
        <aside className="col-span-4 flex min-h-0 flex-col gap-4">
          {/* Runs sidebar */}
          <div className="flex-1 rounded-lg border border-[color:var(--border)] p-3">
            <div className="mb-3 h-4 w-16 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-12 w-full animate-pulse rounded border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40"
                />
              ))}
            </div>
          </div>
          {/* Description */}
          <div className="rounded-lg border border-[color:var(--border)] p-3">
            <div className="mb-2 h-3 w-24 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
            <div className="space-y-1.5">
              <div className="h-2.5 w-full animate-pulse rounded bg-[color:var(--surface-secondary)]" />
              <div className="h-2.5 w-5/6 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
              <div className="h-2.5 w-4/6 animate-pulse rounded bg-[color:var(--surface-secondary)]" />
            </div>
          </div>
        </aside>

        <div className="col-span-8 flex min-h-0 flex-col rounded-lg border border-[color:var(--border)]">
          {/* Tab strip */}
          <div className="flex items-center gap-1 border-b border-[color:var(--border)] px-2 py-1.5">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-7 w-20 animate-pulse rounded-md bg-[color:var(--surface-secondary)]"
              />
            ))}
          </div>
          {/* Body */}
          <div className="flex-1 p-4">
            <div className="mb-2 inline-flex items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 px-2 py-1">
              <svg
                className="h-3.5 w-3.5 animate-spin text-[color:var(--accent)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden
              >
                <path d="M21 12a9 9 0 11-6.22-8.56" />
              </svg>
              <span className="text-[11px] text-[color:var(--muted)]">Loading card…</span>
            </div>
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="h-3 animate-pulse rounded bg-[color:var(--surface-secondary)]"
                  style={{ width: `${60 + ((i * 17) % 35)}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
