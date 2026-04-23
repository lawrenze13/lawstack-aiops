"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { IconX } from "./SidebarIcons";

type Item = {
  id: number;
  ts: number;
  action: string;
  taskId: string | null;
  actor: string;
  unread: boolean;
};

type Props = {
  onClose: () => void;
  onMarkedRead: () => void;
};

function relTime(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 1000);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function humanise(action: string): string {
  return action.replace(/^run\./, "run ").replace(/^chat\./, "chat ").replace(/_/g, " ");
}

export function NotificationsPanel({ onClose, onMarkedRead }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [markPending, setMarkPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/notifications", { cache: "no-store" });
        const json = (await res.json()) as { items?: Item[] };
        if (!cancelled) setItems(json.items ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on Esc; lock scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const markRead = async () => {
    setMarkPending(true);
    try {
      await fetch("/api/notifications/mark-read", { method: "POST" });
      // Optimistic — flip all items to read locally.
      setItems((prev) => prev.map((i) => ({ ...i, unread: false })));
      onMarkedRead();
    } finally {
      setMarkPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Notifications"
      className="fixed inset-0 z-50"
    >
      <button
        type="button"
        aria-label="Close notifications"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <aside className="absolute right-0 top-0 flex h-full w-96 max-w-[90vw] animate-[slideInRight_150ms_ease-out] flex-col border-l border-[color:var(--border)] bg-[color:var(--surface)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[color:var(--border)] px-4 py-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              alerts
            </div>
            <h2 className="mt-0.5 text-sm font-semibold">Notifications</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={markRead}
              disabled={markPending || items.every((i) => !i.unread)}
              className="rounded-md border border-[color:var(--border)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)] transition-colors hover:border-[color:var(--accent)]/60 hover:text-[color:var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {markPending ? "marking…" : "mark all read"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--muted)] hover:bg-[color:var(--surface-secondary)]/60 hover:text-[color:var(--foreground)]"
            >
              <IconX />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center font-mono text-[11px] text-[color:var(--muted)]">
              loading…
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center">
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
                inbox zero
              </div>
              <p className="mt-2 text-xs text-[color:var(--muted)]">
                You&rsquo;ll see run completions, failures, and mentions here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--border)]">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={`flex items-start gap-3 px-4 py-3 text-xs ${
                    item.unread
                      ? "bg-[color:var(--surface-secondary)]/40"
                      : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      item.unread
                        ? "bg-[color:var(--accent)]"
                        : "bg-[color:var(--border)]"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-mono text-[color:var(--muted)]">
                        {item.actor}
                      </span>{" "}
                      <span className="text-[color:var(--foreground)]">
                        {humanise(item.action)}
                      </span>
                      {item.taskId ? (
                        <>
                          {" "}
                          <Link
                            href={`/cards/${item.taskId}`}
                            onClick={onClose}
                            className="font-mono text-[color:var(--accent)] hover:underline"
                          >
                            {item.taskId.slice(0, 8)}
                          </Link>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-[color:var(--muted)]">
                      {relTime(item.ts)} ago
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
