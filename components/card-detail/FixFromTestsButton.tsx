"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { useToast } from "@/components/toast/ToastHost";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  taskId: string;
  /** Card's current_lane. Button only renders on `test`. */
  currentLane: string;
  /** Owner-or-admin gate. */
  canControl: boolean;
  /** True when any run on this task is currently active. */
  runActive: boolean;
  /**
   * Latest test artifact's verdict. Button only renders when verdict
   * is "FAIL" — there's nothing to fix on PASS or SKIPPED, and on
   * SKIPPED the lane already auto-advanced to done so this prop is
   * effectively never passed in that state.
   */
  verdict: "PASS" | "FAIL" | "SKIPPED" | null;
};

/**
 * "Fix from Tests" — launches a brainstorm cycle seeded with the
 * latest test artifact's failure summary as the brainstorm prelude.
 *
 * Unlike Fix from QA, there is no operator picker — the test artifact
 * is the single source of findings. Click → POST to
 * /api/tasks/:id/qa-fix/start with `{ source: "test_failure" }` →
 * fresh ce:brainstorm run with the failures injected → cascade
 * through plan → review → implement → done (skipping the test lane
 * on the test-fix cycle, since re-running the same Playwright suite
 * against new code would be verification theatre).
 */
export function FixFromTestsButton({
  taskId,
  currentLane,
  canControl,
  runActive,
  verdict,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [posting, setPosting] = useState(false);

  if (!canControl) return null;
  if (currentLane !== "test") return null;
  if (verdict !== "FAIL") return null;

  const onClick = async () => {
    setPosting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/qa-fix/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "test_failure" }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      toast.push({
        kind: "success",
        title: "Fix from Tests started",
        body: "Brainstorm is reflowing this card with the test failures as input.",
      });
      startTransition(() => router.refresh());
    } catch (err) {
      toast.push({
        kind: "error",
        title: "Failed to start Fix from Tests",
        body: (err as Error).message,
      });
    } finally {
      setPosting(false);
    }
  };

  const disabled = runActive || posting;
  return (
    <Button
      {...BUTTON_INTENTS["retry"]}
      size="sm"
      isDisabled={disabled}
      onPress={onClick}
    >
      {disabled
        ? posting
          ? "⇡ Starting…"
          : "⇡ Fix from Tests (wait)"
        : "⇡ Fix from Tests"}
    </Button>
  );
}
