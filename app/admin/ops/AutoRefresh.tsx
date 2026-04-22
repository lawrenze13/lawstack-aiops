"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";

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
    <Button
      variant="secondary"
      size="sm"
      onPress={() => setPaused((p) => !p)}
      className="gap-1.5"
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${paused ? "bg-amber-500" : "animate-pulse bg-green-500"}`}
      />
      {paused ? "paused" : `auto-refresh (${secondsLeft}s)`}
    </Button>
  );
}
