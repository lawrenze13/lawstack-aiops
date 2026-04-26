"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  initial: JiraInitial;
};

export type JiraInitial =
  | { configured: false }
  | {
      configured: true;
      baseUrl: string;
      email: string;
      displayName: string | null;
      accountId: string | null;
      tokenLast4: string;
    };

type TestSuccess = {
  ok: true;
  message: string;
  details?: {
    displayName?: string | null;
    emailAddress?: string | null;
    accountId?: string | null;
  };
};
type TestFailure = {
  ok: false;
  reason?: string;
  message: string;
};

export function JiraConnectionCard({ initial }: Props) {
  const [baseUrl, setBaseUrl] = useState(
    initial.configured ? initial.baseUrl : "",
  );
  const [email, setEmail] = useState(
    initial.configured ? initial.email : "",
  );
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [tested, setTested] = useState<TestSuccess | null>(
    initial.configured
      ? {
          ok: true,
          message: `Connected as ${initial.displayName ?? "(unknown)"}`,
          details: {
            displayName: initial.displayName,
            accountId: initial.accountId,
          },
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [pendingClear, startClear] = useTransition();
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  // Saved-but-unedited state: form pre-filled but no token in the input.
  // Saving requires re-entering the token (we never echo it back).
  const dirty =
    baseUrl !== (initial.configured ? initial.baseUrl : "") ||
    email !== (initial.configured ? initial.email : "") ||
    apiToken.length > 0;

  // Tear down test result when the user edits any field.
  useEffect(() => {
    setTested(null);
    setError(null);
    setSavedAt(null);
  }, [baseUrl, email, apiToken]);

  const test = () => {
    setError(null);
    setRetryAfter(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/credentials/test/jira", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, email, apiToken }),
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
        const res = await fetch("/api/profile/credentials/save/jira", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, email, apiToken }),
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
        setApiToken(""); // never keep secret in DOM after save
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const clearOverride = () => {
    setError(null);
    startClear(async () => {
      try {
        const res = await fetch("/api/profile/credentials/jira", {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `HTTP ${res.status}`);
          return;
        }
        setBaseUrl("");
        setEmail("");
        setApiToken("");
        setTested(null);
        setSavedAt(Date.now());
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const canSave = tested?.ok === true && dirty && apiToken.length > 0;

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)]">
      <header className="border-b border-[color:var(--border)] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          connections · jira
        </div>
        <h2 className="mt-1 text-sm font-semibold">
          Jira credentials
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
          When set, runs you create use these credentials in place of the
          instance default. Comments, transitions, and identity all reflect
          you in Jira&apos;s audit trail.
        </p>
      </header>

      <div className="space-y-4 p-4">
        <Field label="Base URL" hint="e.g. https://acme.atlassian.net">
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-org.atlassian.net"
            className={inputCls}
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputCls}
          />
        </Field>

        <Field
          label="API token"
          hint={
            initial.configured
              ? `Saved token ends ${initial.tokenLast4}. Re-enter to update.`
              : "Get one at id.atlassian.com → Security → API tokens"
          }
        >
          <div className="flex gap-2">
            <input
              type={showToken ? "text" : "password"}
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder={
                initial.configured ? "Enter to replace…" : "Paste API token"
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
          <div className="rounded-md border border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10 px-3 py-2 text-xs">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
              ✓ verified
            </div>
            <div className="mt-1">
              {tested.message}
              {tested.details?.emailAddress
                ? ` (${tested.details.emailAddress})`
                : null}
            </div>
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
              isDisabled={
                pending || !baseUrl || !email || !apiToken || retryAfter !== null
              }
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
