"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  initial: GithubInitial;
};

export type GithubInitial =
  | { configured: false }
  | { configured: true; login: string | null; tokenLast4: string };

type TestSuccess = {
  ok: true;
  message: string;
  details?: {
    login?: string;
    repoAccess?:
      | { ok: true; fullName: string }
      | { ok: false; reason: string; message: string };
    warning?: string;
  };
};
type TestFailure = {
  ok: false;
  reason?: string;
  message: string;
};

export function GithubConnectionCard({ initial }: Props) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [tested, setTested] = useState<TestSuccess | null>(
    initial.configured
      ? {
          ok: true,
          message: `Connected as @${initial.login ?? "(unknown)"}`,
          details: { login: initial.login ?? undefined },
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [pendingClear, startClear] = useTransition();
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  useEffect(() => {
    setTested(null);
    setError(null);
    setSavedAt(null);
  }, [token]);

  const test = () => {
    setError(null);
    setRetryAfter(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/credentials/test/github", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (res.status === 429) {
          const j = (await res.json().catch(() => ({}))) as { retryAfterSec?: number };
          setRetryAfter(j.retryAfterSec ?? 60);
          setError("Too many attempts. Try again later.");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as
          | TestSuccess
          | TestFailure;
        if (!res.ok || !body.ok) {
          setTested(null);
          setError((body as TestFailure).message ?? `HTTP ${res.status}`);
          return;
        }
        setTested(body);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const save = () => {
    setError(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/credentials/save/github", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          saved?: boolean;
          message?: string;
        };
        if (!res.ok || !body.saved) {
          setError(body.message ?? `HTTP ${res.status}`);
          return;
        }
        setSavedAt(Date.now());
        setToken("");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const clearOverride = () => {
    setError(null);
    startClear(async () => {
      try {
        const res = await fetch("/api/profile/credentials/github", {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `HTTP ${res.status}`);
          return;
        }
        setToken("");
        setTested(null);
        setSavedAt(Date.now());
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const canSave = tested?.ok === true && token.length > 0;
  const repoAccess = tested?.details?.repoAccess;

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)]">
      <header className="border-b border-[color:var(--border)] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          connections · github
        </div>
        <h2 className="mt-1 text-sm font-semibold">
          GitHub PAT
          {initial.configured ? (
            <span className="ml-2 rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
              configured
            </span>
          ) : (
            <span className="ml-2 rounded-full border border-[color:var(--border)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
              instance default
            </span>
          )}
        </h2>
        <p className="mt-1 text-xs text-[color:var(--muted)]">
          PRs you author land under this token. Recommended: a{" "}
          <a
            href="https://github.com/settings/personal-access-tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-[color:var(--foreground)]"
          >
            fine-grained PAT
          </a>{" "}
          scoped to BASE_REPO with{" "}
          <span className="font-mono">Contents r/w</span>,{" "}
          <span className="font-mono">Pull requests r/w</span>,{" "}
          <span className="font-mono">Metadata read</span>.
        </p>
      </header>

      <div className="space-y-4 p-4">
        <Field
          label="Personal access token"
          hint={
            initial.configured
              ? `Saved token ends ${initial.tokenLast4}. Re-enter to update.`
              : "Starts with ghp_ or github_pat_"
          }
        >
          <div className="flex gap-2">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                initial.configured ? "Enter to replace…" : "Paste token"
              }
              autoComplete="off"
              className={inputCls + " font-mono text-xs"}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="rounded-md border border-[color:var(--border)] px-2 text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]"
            >
              {showToken ? "hide" : "show"}
            </button>
          </div>
        </Field>

        {tested?.ok && (
          <div className="space-y-2">
            <div className="rounded-md border border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10 px-3 py-2 text-xs">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
                ✓ verified
              </div>
              <div className="mt-1">{tested.message}</div>
            </div>
            {repoAccess?.ok === true && (
              <div className="text-[11px] text-[color:var(--muted)]">
                ↳ Repo access:{" "}
                <span className="font-mono">{repoAccess.fullName}</span> ✓
              </div>
            )}
            {repoAccess?.ok === false && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                ⚠ {repoAccess.message}
              </div>
            )}
            {tested.details?.warning && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                ⚠ {tested.details.warning}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700">
            {error}
            {retryAfter ? ` (retry in ~${retryAfter}s)` : null}
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
          <div className="flex gap-2">
            <Button
              {...BUTTON_INTENTS["neutral-secondary"]}
              size="sm"
              onPress={test}
              isDisabled={pending || !token || retryAfter !== null}
            >
              {pending ? "Testing…" : "Test connection"}
            </Button>
            <Button
              {...BUTTON_INTENTS["primary-action"]}
              size="sm"
              onPress={save}
              isDisabled={!canSave || pending}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const inputCls =
  "w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2 text-sm text-[color:var(--foreground)] focus:border-[color:var(--accent)] focus:outline-none";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[10px] text-[color:var(--muted)]">{hint}</p>
      )}
    </div>
  );
}
