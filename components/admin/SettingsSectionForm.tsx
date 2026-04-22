"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import { FieldInput } from "@/components/setup/FieldInput";
import { StepTest } from "@/components/setup/StepTest";
import type { SettingSection } from "@/server/lib/settingsSchema";

type TestResult = { ok: boolean; message: string };

type Props = {
  section: SettingSection;
  initialValues: Record<string, unknown>;
};

/**
 * One collapsible section on /admin/settings. Per-section Save button
 * writes only that section's fields via /api/admin/settings/save.
 * Preserves unsaved edits on other sections when you save one.
 *
 * Test action (if the section has one) is always available, uses the
 * /api/admin/settings/test/:id admin-gated endpoint.
 */
export function SettingsSectionForm({ section, initialValues }: Props) {
  const [open, setOpen] = useState(true);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const f of section.fields) seed[f.key] = initialValues[f.key];
    return seed;
  });
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const setField = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setError(null);
    setSavedAt(null);
  };

  const save = () => {
    setError(null);
    start(async () => {
      try {
        const res = await fetch("/api/admin/settings/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values }),
        });
        const json = (await res.json()) as {
          saved?: string[];
          rejected?: Array<{ key: string; error: string }>;
          error?: string;
        };
        if (!res.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          return;
        }
        if (json.rejected && json.rejected.length > 0) {
          setError(
            json.rejected.map((r) => `${r.key}: ${r.error}`).join("; "),
          );
          return;
        }
        setDirty(false);
        setSavedAt(Date.now());
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)]">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] px-4 py-3">
        <div className="flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-left"
          >
            <span className="mr-2 text-xs text-[color:var(--muted)]">
              {open ? "▾" : "▸"}
            </span>
            <span className="text-sm font-semibold">{section.title}</span>
          </button>
          <p className="mt-0.5 ml-5 text-xs text-[color:var(--muted)]">
            {section.description}
          </p>
        </div>
        {dirty ? (
          <Chip color="warning" variant="soft" size="sm">
            unsaved
          </Chip>
        ) : savedAt ? (
          <Chip color="success" variant="soft" size="sm">
            saved
          </Chip>
        ) : null}
      </header>

      {open ? (
        <div className="p-4 space-y-4">
          {section.fields.length === 0 ? (
            <p className="text-sm text-[color:var(--muted)]">
              No editable fields in this section (CI workflow step — see
              wizard).
            </p>
          ) : (
            section.fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <label className="block text-xs font-medium uppercase tracking-wide text-[color:var(--muted)]">
                  {field.label}
                  {field.required ? (
                    <span className="ml-1 text-[color:var(--accent)]">*</span>
                  ) : null}
                </label>
                <FieldInput
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => setField(field.key, v)}
                  previouslySet={
                    field.mask &&
                    typeof initialValues[field.key] === "string" &&
                    (initialValues[field.key] as string).length > 0 &&
                    values[field.key] === initialValues[field.key]
                  }
                />
                {field.kind !== "boolean" ? (
                  <p className="text-[11px] text-[color:var(--muted)]">
                    {field.description}
                  </p>
                ) : null}
              </div>
            ))
          )}

          {section.test ? (
            <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 p-3">
              <StepTest
                token=""
                test={section.test}
                values={values}
                onResult={setTestResult}
              />
              {testResult ? (
                <p className="mt-2 text-[11px] text-[color:var(--muted)]">
                  Last test: {testResult.ok ? "✓" : "✘"} {testResult.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          ) : null}

          {section.fields.length > 0 ? (
            <div className="flex justify-end">
              <Button
                {...BUTTON_INTENTS["primary-action"]}
                size="sm"
                onPress={save}
                isDisabled={saving || !dirty}
              >
                {saving ? "Saving…" : "Save section"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
