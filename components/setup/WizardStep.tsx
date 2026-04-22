"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import type { SettingSection } from "@/server/lib/settingsSchema";
import { FieldInput } from "./FieldInput";
import { StepTest } from "./StepTest";

type TestResult = {
  ok: boolean;
  message: string;
};

type Props = {
  token: string;
  stepNumber: number;
  totalSteps: number;
  section: SettingSection;
  initialValues: Record<string, unknown>;
};

/**
 * A single wizard step: header, fields, optional Test action, Prev/Next.
 *
 * Next is disabled until the section's Test (if any) returns ok=true —
 * unless the section is wizardOptional, in which case a "Skip this step"
 * link jumps to the next step without saving.
 */
export function WizardStep({
  token,
  stepNumber,
  totalSteps,
  section,
  initialValues,
}: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const isLastStep = stepNumber >= totalSteps;
  const setField = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Invalidate a prior test result if the user edits the underlying fields.
    if (testResult && section.test?.requires.includes(key)) {
      setTestResult(null);
    }
  };

  const save = (thenRoute: string) => {
    setSaveError(null);
    startSave(async () => {
      try {
        const res = await fetch(
          `/api/setup/save?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ values }),
          },
        );
        const json = (await res.json()) as {
          saved?: string[];
          rejected?: Array<{ key: string; error: string }>;
          error?: string;
        };
        if (!res.ok) {
          setSaveError(json.error ?? `HTTP ${res.status}`);
          return;
        }
        if (json.rejected && json.rejected.length > 0) {
          setSaveError(
            json.rejected
              .map((r) => `${r.key}: ${r.error}`)
              .join("; "),
          );
          return;
        }
        router.push(thenRoute);
      } catch (err) {
        setSaveError((err as Error).message);
      }
    });
  };

  const goNext = () => {
    const next = isLastStep
      ? `/?setup=complete`
      : `/setup/step/${stepNumber + 1}?token=${encodeURIComponent(token)}`;
    save(next);
  };

  const skip = () => {
    const next = isLastStep
      ? `/?setup=complete`
      : `/setup/step/${stepNumber + 1}?token=${encodeURIComponent(token)}`;
    router.push(next);
  };

  const goPrev = () => {
    if (stepNumber <= 1) return;
    router.push(
      `/setup/step/${stepNumber - 1}?token=${encodeURIComponent(token)}`,
    );
  };

  // Gate logic: Next is enabled when
  //   - section has no test → always enabled
  //   - section has test and test has passed → enabled
  //   - section is wizardOptional → Skip is always enabled (separate link)
  const canProceed = !section.test || testResult?.ok === true;

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-6">
      <div className="mb-1 text-xs font-mono text-[color:var(--muted)]">
        Step {stepNumber} of {totalSteps}
      </div>
      <h1 className="text-lg font-semibold">{section.title}</h1>
      <p className="mt-1 text-sm text-[color:var(--muted)]">
        {section.description}
      </p>

      <div className="mt-5 space-y-4">
        {section.fields.map((field) => (
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
        ))}
      </div>

      {section.test ? (
        <div className="mt-5 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 p-3">
          <StepTest
            token={token}
            test={section.test}
            values={values}
            onResult={setTestResult}
          />
        </div>
      ) : null}

      {saveError ? (
        <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
          {saveError}
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <Button
          {...BUTTON_INTENTS["neutral-secondary"]}
          size="sm"
          onPress={goPrev}
          isDisabled={stepNumber <= 1 || saving}
        >
          ← Back
        </Button>
        <div className="flex items-center gap-2">
          {section.wizardOptional ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={skip}
              isDisabled={saving}
            >
              Skip this step
            </Button>
          ) : null}
          <Button
            {...BUTTON_INTENTS["primary-action"]}
            size="sm"
            onPress={goNext}
            isDisabled={!canProceed || saving}
          >
            {saving ? "Saving…" : isLastStep ? "Finish" : "Save & continue →"}
          </Button>
        </div>
      </div>
    </section>
  );
}
