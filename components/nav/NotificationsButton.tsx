"use client";

import { useCallback, useEffect, useState } from "react";
import { IconBell } from "./SidebarIcons";
import { NotificationsPanel } from "./NotificationsPanel";

const POLL_MS = 30_000;

/**
 * Sidebar bell icon + unread-count badge. Polls
 * /api/notifications/unread-count every 30s. Opens a slide-out panel
 * that lists recent events and exposes a "mark all read" action.
 *
 * Mounted inside the server-rendered Sidebar; this is the only client
 * piece the nav needs. Failure to poll is silent (the badge just
 * freezes at its last value).
 */
export function NotificationsButton() {
  const [count, setCount] = useState<number>(0);
  const [open, setOpen] = useState(false);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { count?: number };
      if (typeof json.count === "number") setCount(json.count);
    } catch {
      // network burp; keep last value
    }
  }, []);

  useEffect(() => {
    void fetchCount();
    const id = window.setInterval(fetchCount, POLL_MS);
    return () => window.clearInterval(id);
  }, [fetchCount]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`}
        className="group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm text-[color:var(--muted)] transition-colors hover:bg-[color:var(--surface-secondary)]/60 hover:text-[color:var(--foreground)]"
      >
        <span className="inline-flex h-4 w-4 items-center justify-center text-[color:var(--muted)] group-hover:text-[color:var(--foreground)]">
          <IconBell />
        </span>
        <span className="flex-1 truncate text-left">Alerts</span>
        {count > 0 ? (
          <span className="min-w-[18px] rounded-full bg-[color:var(--accent)] px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold text-[color:var(--accent-foreground)]">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <NotificationsPanel
          onClose={() => setOpen(false)}
          onMarkedRead={() => {
            setCount(0);
            void fetchCount();
          }}
        />
      ) : null}
    </>
  );
}
