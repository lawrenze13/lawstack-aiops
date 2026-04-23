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
  /** URL the wizard itself was served on — pre-filled into AUTH_URL. */
  detectedAuthUrl?: string;
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
  detectedAuthUrl,
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

  // When the last step finishes, send the operator straight to /sign-in so
  // they create their first admin account via Google. /sign-in will detect
  // OAuth is now configured and show the Continue-with-Google button.
  const goNext = () => {
    const next = isLastStep
      ? `/sign-in?from=/`
      : `/setup/step/${stepNumber + 1}?token=${encodeURIComponent(token)}`;
    save(next);
  };

  const skip = () => {
    const next = isLastStep
      ? `/sign-in?from=/`
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

      {section.id === "auth" ? (
        <GoogleRedirectHint
          authUrl={typeof values.AUTH_URL === "string" ? values.AUTH_URL : ""}
          detected={detectedAuthUrl}
        />
      ) : null}

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

      {/* Gap separator before nav buttons. */}
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

/**
 * Live panel rendered under the auth step that prints the exact callback
 * URL the operator must paste into the Google Cloud Console OAuth
 * client's "Authorized redirect URIs" list. Updates as the user edits
 * AUTH_URL so a typo gets caught before they click Save.
 *
 * Rendered only on the auth section; safe to no-op if AUTH_URL is empty.
 */
function GoogleRedirectHint({
  authUrl,
  detected,
}: {
  authUrl: string;
  detected?: string;
}) {
  const effective = authUrl.trim().replace(/\/+$/, "") || detected?.trim() || "";
  if (!effective) return null;

  const callback = `${effective}/api/auth/callback/google`;
  const matchesDetected =
    detected && effective.replace(/\/+$/, "") === detected.replace(/\/+$/, "");

  return (
    <div className="mt-5 rounded-md border border-[color:var(--accent)]/30 bg-[color:var(--accent)]/5 p-3">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--accent)]">
        paste into google cloud console
      </div>
      <p className="text-[12px] leading-relaxed text-[color:var(--foreground)]">
        Add this exact URL under{" "}
        <span className="font-mono text-[color:var(--muted)]">
          Credentials → OAuth client → Authorized redirect URIs
        </span>
        :
      </p>
      <code className="mt-2 block select-all overflow-x-auto rounded border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/70 px-2 py-1.5 font-mono text-[12px] text-[color:var(--foreground)]">
        {callback}
      </code>
      {!matchesDetected && detected ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
          Heads up: you&apos;re editing this wizard on{" "}
          <span className="font-mono">{detected}</span>. If your public URL
          is different, make sure DNS + the reverse proxy resolve to this
          app before saving.
        </p>
      ) : null}
    </div>
  );
}
