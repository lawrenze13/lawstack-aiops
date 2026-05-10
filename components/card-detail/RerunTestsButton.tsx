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
};

/**
 * "Re-run Tests" — kicks off a fresh `test:playwright` run on the
 * current branch without going back through brainstorm. Used when:
 *   - the prior run failed because of a flake (operator wants to
 *     retry the same suite),
 *   - the operator made a tiny tweak in the worktree and wants to
 *     re-verify before approving Fix from Tests,
 *   - infra was down (browsers couldn't install) and is now back.
 *
 * Backs onto the same /api/tasks/:id/runs endpoint that the lane's
 * Run button uses; mutex in spawnAgent guarantees the new run waits
 * for any other Playwright run to finish before forking.
 */
export function RerunTestsButton({
  taskId,
  currentLane,
  canControl,
  runActive,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [posting, setPosting] = useState(false);

  if (!canControl) return null;
  if (currentLane !== "test") return null;

  const onClick = async () => {
    setPosting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lane: "test",
          agentId: "test:playwright",
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      toast.push({
        kind: "success",
        title: "Test run started",
        body: "Playwright is re-running the suite.",
      });
      startTransition(() => router.refresh());
    } catch (err) {
      toast.push({
        kind: "error",
        title: "Failed to re-run tests",
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
        ? pending || posting
          ? "↻ Re-running…"
          : "↻ Re-run Tests (wait)"
        : "↻ Re-run Tests"}
    </Button>
  );
}
