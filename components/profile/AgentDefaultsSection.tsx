"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import type { AgentOverrides } from "@/server/lib/userPrefs";

type AgentSummary = {
  id: string;
  label: string;
  instanceModel: string;
  instanceCostWarnUsd: number;
  instanceCostKillUsd: number;
  /** Sample-filled built-in prompt this agent uses. Displayed so users
   *  can see the floor they're augmenting with promptAppend. */
  basePrompt: string;
};

type Props = {
  agents: AgentSummary[];
  initial: AgentOverrides;
  /** Models available in the Claude Code wrapper. Kept in sync with the wizard. */
  models: Array<{ value: string; label: string }>;
};

export function AgentDefaultsSection({ agents, initial, models }: Props) {
  const [overrides, setOverrides] = useState<AgentOverrides>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const setField = (
    agentId: string,
    key: "model" | "costWarnUsd" | "costKillUsd" | "promptAppend",
    value: string | number | undefined,
  ) => {
    setOverrides((prev) => {
      const row = { ...(prev[agentId] ?? {}) };
      if (value === undefined || value === "") delete row[key];
      else (row as Record<string, unknown>)[key] = value;
      return Object.keys(row).length > 0
        ? { ...prev, [agentId]: row }
        : // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ((): AgentOverrides => {
            const { [agentId]: _drop, ...rest } = prev;
            return rest;
          })();
    });
    setSavedAt(null);
    setError(null);
  };

  const MAX_APPEND = 500;

  const save = () => {
    setError(null);
    start(async () => {
      try {
        const res = await fetch("/api/profile/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentOverrides: overrides }),
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
          profile · agents
        </div>
        <h2 className="mt-1 text-sm font-semibold">Personal agent defaults</h2>
        <p className="mt-1 text-[11px] text-[color:var(--muted)]">
          Overrides the instance-wide defaults for runs <em>you</em> kick off.
          Leave a field blank to use the instance default.
        </p>
      </header>

      <div className="divide-y divide-[color:var(--border)]">
        {agents.map((a) => {
          const o = overrides[a.id] ?? {};
          return (
            <div key={a.id} className="p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <div>
                  <div className="font-mono text-sm font-semibold text-[color:var(--foreground)]">
                    {a.id}
                  </div>
                  <div className="text-[11px] text-[color:var(--muted)]">
                    {a.label}
                  </div>
                </div>
                <div className="text-right font-mono text-[10px] text-[color:var(--muted)]">
                  instance: {a.instanceModel} · warn ${a.instanceCostWarnUsd} ·
                  kill ${a.instanceCostKillUsd}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Sub label="Model">
                  <select
                    value={o.model ?? ""}
                    onChange={(e) =>
                      setField(a.id, "model", e.target.value || undefined)
                    }
                    className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-2 py-1.5 text-xs text-[color:var(--foreground)]"
                  >
                    <option value="">(use instance)</option>
                    {models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Sub>
                <Sub label="Warn @ $">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={o.costWarnUsd ?? ""}
                    placeholder={String(a.instanceCostWarnUsd)}
                    onChange={(e) =>
                      setField(
                        a.id,
                        "costWarnUsd",
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                      )
                    }
                    className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-2 py-1.5 text-xs text-[color:var(--foreground)]"
                  />
                </Sub>
                <Sub label="Kill @ $">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={o.costKillUsd ?? ""}
                    placeholder={String(a.instanceCostKillUsd)}
                    onChange={(e) =>
                      setField(
                        a.id,
                        "costKillUsd",
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                      )
                    }
                    className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-2 py-1.5 text-xs text-[color:var(--foreground)]"
                  />
                </Sub>
              </div>

              {/* Prompt append — extra operator instructions, concatenated
                  onto the built-in prompt at run time. Base prompt is
                  visible in a collapsed panel so users see exactly what
                  their notes augment. */}
              <div className="mt-4">
                <div className="mb-1 flex items-baseline justify-between">
                  <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
                    extra instructions
                  </div>
                  <div
                    className={`font-mono text-[10px] ${
                      (o.promptAppend?.length ?? 0) > MAX_APPEND * 0.9
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-[color:var(--muted)]"
                    }`}
                  >
                    {(o.promptAppend?.length ?? 0)}/{MAX_APPEND}
                  </div>
                </div>
                <textarea
                  rows={3}
                  maxLength={MAX_APPEND}
                  value={o.promptAppend ?? ""}
                  placeholder='e.g. "Always check docs/changelog.md before finishing."'
                  onChange={(e) =>
                    setField(
                      a.id,
                      "promptAppend",
                      e.target.value === "" ? undefined : e.target.value,
                    )
                  }
                  className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-[color:var(--foreground)] placeholder:text-[color:var(--muted)] focus:border-[color:var(--accent)] focus:outline-none"
                />
                <p className="mt-1 text-[10px] text-[color:var(--muted)]">
                  Appended verbatim under an <code>## Operator notes</code>{" "}
                  heading when <span className="font-mono">{a.id}</span>{" "}
                  runs. The built-in prompt is always preserved.
                </p>

                <details className="group mt-2">
                  <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)] hover:text-[color:var(--foreground)]">
                    <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                      ▸
                    </span>
                    show built-in prompt ({a.basePrompt.length.toLocaleString()} chars)
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 p-3 font-mono text-[11px] leading-relaxed text-[color:var(--muted)]">
                    {a.basePrompt}
                  </pre>
                  <p className="mt-1 text-[10px] text-[color:var(--muted)]">
                    Preview filled with placeholder values. Actual run uses
                    the real Jira key, title, description, and upstream
                    artifacts.
                  </p>
                </details>
              </div>
            </div>
          );
        })}
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
          {pending ? "Saving…" : "Save overrides"}
        </Button>
      </footer>
    </section>
  );
}

function Sub({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}
