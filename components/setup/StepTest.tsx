"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import type { SettingSection } from "@/server/lib/settingsSchema";

type TestResult = {
  ok: boolean;
  message: string;
  details?: Record<string, { ok: boolean; message: string }>;
};

type Props = {
  token: string;
  test: NonNullable<SettingSection["test"]>;
  /** Current unsaved form values — fed to the test payload. */
  values: Record<string, unknown>;
  /** Called with the test result so the Wizard can gate Next on ok=true. */
  onResult: (result: TestResult) => void;
};

/**
 * "Test" button for a wizard step. Hits /api/setup/test/:id with the
 * relevant subset of values, renders the result as a Chip.
 */
export function StepTest({ token, test, values, onResult }: Props) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<TestResult | null>(null);

  const run = () => {
    const payload: Record<string, unknown> = {};
    for (const key of test.requires) payload[key] = values[key];
    start(async () => {
      try {
        const res = await fetch(
          `/api/setup/test/${test.id}?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const json = (await res.json()) as TestResult;
        setResult(json);
        onResult(json);
      } catch (err) {
        const fail: TestResult = {
          ok: false,
          message: `Request failed: ${(err as Error).message}`,
        };
        setResult(fail);
        onResult(fail);
      }
    });
  };

  return (
    <div className="flex items-center gap-3">
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        isDisabled={pending}
        onPress={run}
      >
        {pending ? "Testing…" : test.label}
      </Button>
      {result ? (
        <Chip
          color={result.ok ? "success" : "danger"}
          variant="soft"
          size="sm"
        >
          {result.ok ? "✓" : "✘"} {result.message}
        </Chip>
      ) : null}
    </div>
  );
}
