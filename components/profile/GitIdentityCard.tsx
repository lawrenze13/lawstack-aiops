"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  initial: GitIdentityInitial;
  defaultName: string;
  defaultEmail: string;
};

export type GitIdentityInitial =
  | { configured: false }
  | { configured: true; name: string; email: string };

/**
 * Per-task git author identity. Worker writes
 * `git config --local user.name/user.email` in the worktree before any
 * commit, so PRs you author show your name in `git log`. Falls back to
 * the box's hardcoded `lawstack-aiops <ai-ops@multiportal.io>` when
 * unset.
 */
export function GitIdentityCard({
  initial,
  defaultName,
  defaultEmail,
}: Props) {
  const [name, setName] = useState(
    initial.configured ? initial.name : defaultName,
  );
  const [email, setEmail] = useState(
    initial.configured ? initial.email : defaultEmail,
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [pendingClear, startClear] = useTransition();

  const dirty =
    name !== (initial.configured ? initial.name : defaultName) ||
    email !== (initial.configured ? initial.email : defaultEmail);

  const save = () => {
    setError(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/credentials/save/git", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, email }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          saved?: boolean;
          message?: string;
          issues?: unknown;
        };
        if (!res.ok || !body.saved) {
          setError(body.message ?? `HTTP ${res.status}`);
          return;
        }
        setSavedAt(Date.now());
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const clearOverride = () => {
    setError(null);
    startClear(async () => {
      try {
        const res = await fetch("/api/profile/credentials/git", {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `HTTP ${res.status}`);
          return;
        }
        setName(defaultName);
        setEmail(defaultEmail);
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
          connections · git identity
        </div>
        <h2 className="mt-1 text-sm font-semibold">
          Git author
          {initial.configured ? (
            <span className="ml-2 rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
              configured
            </span>
          ) : (
            <span className="ml-2 rounded-full border border-[color:var(--border)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
              fallback
            </span>
          )}
        </h2>
        <p className="mt-1 text-xs text-[color:var(--muted)]">
          Used for{" "}
          <span className="font-mono">git config --local user.name/email</span>{" "}
          in your task worktrees, so commits — not just PRs — show you as the
          author.
        </p>
      </header>

      <div className="space-y-4 p-4">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alice Engineer"
            className={inputCls}
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alice@example.com"
            className={inputCls}
          />
        </Field>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--border)] pt-3">
          <div className="flex items-center gap-2 text-xs">
            {savedAt && !error ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
                ✓ saved
              </span>
            ) : null}
            {initial.configured && (
              <button
                type="button"
                onClick={clearOverride}
                disabled={pendingClear}
                className="text-[11px] text-[color:var(--muted)] underline-offset-2 hover:text-[color:var(--foreground)] hover:underline disabled:opacity-50"
              >
                {pendingClear ? "Clearing…" : "Use instance default"}
              </button>
            )}
          </div>
          <Button
            {...BUTTON_INTENTS["primary-action"]}
            size="sm"
            onPress={save}
            isDisabled={!dirty || pending || !name || !email}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </section>
  );
}

const inputCls =
  "w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2 text-sm text-[color:var(--foreground)] focus:border-[color:var(--accent)] focus:outline-none";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}
