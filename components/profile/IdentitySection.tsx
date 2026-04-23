"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

type Props = {
  initialName: string;
  email: string;
};

export function IdentitySection({ initialName, email }: Props) {
  const [name, setName] = useState(initialName);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = name !== initialName;

  const save = () => {
    setError(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
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
          profile · identity
        </div>
        <h2 className="mt-1 text-sm font-semibold">Who you are</h2>
      </header>

      <div className="space-y-4 p-4">
        <Field label="Display name">
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSavedAt(null);
              setError(null);
            }}
            className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2 text-sm text-[color:var(--foreground)] focus:border-[color:var(--accent)] focus:outline-none"
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={email}
            readOnly
            className="w-full cursor-not-allowed rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/30 px-3 py-2 font-mono text-xs text-[color:var(--muted)]"
          />
          <p className="mt-1 text-[10px] text-[color:var(--muted)]">
            Email comes from your Google account; changing it means signing in
            with a different Google user.
          </p>
        </Field>

        <Field label="Theme">
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-[11px] text-[color:var(--muted)]">
              Device-local — remembered on this browser.
            </span>
          </div>
        </Field>

        <div className="flex items-center justify-between border-t border-[color:var(--border)] pt-3">
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
            isDisabled={!dirty || pending}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </section>
  );
}

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
