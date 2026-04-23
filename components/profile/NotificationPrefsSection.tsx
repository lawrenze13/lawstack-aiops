"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import type { Notifications } from "@/server/lib/userPrefs";

type Props = {
  initial: Notifications;
};

const TOGGLES: Array<{
  key: keyof Notifications;
  label: string;
  description: string;
}> = [
  {
    key: "onComplete",
    label: "Run completed",
    description:
      "Notify me when one of my runs finishes successfully (for long-running agents).",
  },
  {
    key: "onFailure",
    label: "Run failed",
    description:
      "Notify me when my run errors out, hits cost-kill, or is marked interrupted.",
  },
  {
    key: "onAwaitingInput",
    label: "Awaiting my input",
    description:
      "Notify me when a run pauses waiting on a prompt response from me.",
  },
];

export function NotificationPrefsSection({ initial }: Props) {
  const [prefs, setPrefs] = useState<Notifications>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (key: keyof Notifications) => {
    setPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
    setSavedAt(null);
    setError(null);
  };

  const save = () => {
    setError(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notifications: prefs }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setSavedAt(Date.now());
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)]">
      <header className="border-b border-[color:var(--border)] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          profile · notifications
        </div>
        <h2 className="mt-1 text-sm font-semibold">When to ping me</h2>
        <p className="mt-1 text-[11px] text-[color:var(--muted)]">
          These flags gate what shows up in your Notifications tray. Email /
          Slack delivery follows in a later release.
        </p>
      </header>

      <div className="divide-y divide-[color:var(--border)]">
        {TOGGLES.map((t) => (
          <label
            key={t.key}
            className="flex cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-[color:var(--surface-secondary)]/40"
          >
            <input
              type="checkbox"
              checked={Boolean(prefs[t.key])}
              onChange={() => toggle(t.key)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-[color:var(--accent)]"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[color:var(--foreground)]">
                {t.label}
              </div>
              <div className="mt-0.5 text-[11px] text-[color:var(--muted)]">
                {t.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      <footer className="flex items-center justify-between border-t border-[color:var(--border)] p-3">
        {error ? (
          <span className="text-xs text-red-600">{error}</span>
        ) : savedAt ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
            ✓ saved
          </span>
        ) : (
          <span />
        )}
        <Button
          {...BUTTON_INTENTS["primary-action"]}
          size="sm"
          onPress={save}
          isDisabled={pending}
        >
          {pending ? "Saving…" : "Save prefs"}
        </Button>
      </footer>
    </section>
  );
}
