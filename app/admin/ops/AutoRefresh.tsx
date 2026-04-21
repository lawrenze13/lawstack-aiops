"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Periodically calls router.refresh() so the ops page's server-fetched
 * tables (stuck runs, audit log, etc.) stay live. Includes a pause
 * toggle + countdown so operators can freeze the view while reading.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(intervalMs / 1000));

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, Math.round((intervalMs - elapsed) / 1000));
      setSecondsLeft(remaining);
    }, 500);
    const refresh = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [intervalMs, paused, router]);

  return (
    <button
      type="button"
      onClick={() => setPaused((p) => !p)}
      className="flex items-center gap-1.5 rounded border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-1 text-[10px] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)]"
      title={paused ? "Auto-refresh paused — click to resume" : `Refreshes every ${intervalMs / 1000}s`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${paused ? "bg-amber-500" : "animate-pulse bg-green-500"}`}
      />
      {paused ? "paused" : `auto-refresh (${secondsLeft}s)`}
    </button>
  );
}
