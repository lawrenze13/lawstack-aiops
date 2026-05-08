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
};

/**
 * "Skip Tests" — operator escape hatch. Records `test.skipped`,
 * posts a Jira comment (with optional reason), and moves the lane
 * to `done`. Used when Playwright is broken for non-code reasons
 * (flaky CI, infra outage, browser install repeatedly failing, etc.)
 * and the operator decides the implementation is shippable anyway.
 *
 * Always renders on the test lane regardless of verdict — even on
 * PASS the operator may want a manual escape (e.g. reports persist
 * step failed). Confirm prompt with reason input before posting.
 */
export function SkipTestsButton({ taskId, currentLane, canControl }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [posting, setPosting] = useState(false);

  if (!canControl) return null;
  if (currentLane !== "test") return null;

  const onConfirm = async () => {
    setPosting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/skip-tests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      toast.push({
        kind: "success",
        title: "Tests skipped",
        body: "Card moved to done. Jira comment posted.",
      });
      setOpen(false);
      setReason("");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.push({
        kind: "error",
        title: "Failed to skip tests",
        body: (err as Error).message,
      });
    } finally {
      setPosting(false);
    }
  };

  return (
    <>
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        onPress={() => setOpen(true)}
      >
        ⏭ Skip Tests
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => !posting && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-lg font-semibold">Skip the test lane?</h3>
            <p className="mb-4 text-sm text-default-600">
              The card will move to <code>done</code> without a Playwright
              verification. A Jira comment will record the skip. Use this
              when the test infrastructure is broken — not when tests are
              actually failing.
            </p>
            <label className="mb-1 block text-sm font-medium">
              Reason (optional)
            </label>
            <textarea
              className="mb-4 h-20 w-full rounded border border-default-300 p-2 text-sm"
              placeholder="e.g. Playwright browser install failing on this machine"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              disabled={posting}
            />
            <div className="flex justify-end gap-2">
              <Button
                {...BUTTON_INTENTS["neutral-secondary"]}
                size="sm"
                isDisabled={posting}
                onPress={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                {...BUTTON_INTENTS["destructive"]}
                size="sm"
                isDisabled={posting}
                onPress={onConfirm}
              >
                {posting ? "Skipping…" : "Skip Tests"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
