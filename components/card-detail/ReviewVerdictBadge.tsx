"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import {
  Popover,
  PopoverContent,
  PopoverDialog,
  PopoverTrigger,
} from "@heroui/react/popover";
import { BUTTON_INTENTS, VERDICT_CHIP } from "@/components/ui/tokens";

export type ReviewVerdictState =
  | { kind: "none" }
  | { kind: "pending"; since: number }
  | {
      kind: "verdict";
      verdict: "PASS" | "P1" | "P2_BLOCKER";
      blockers: string | null;
      at: number;
    };

type Props = {
  taskId: string;
  initial: ReviewVerdictState;
};

/**
 * Surfaces the CI code-review verdict on the card header.
 *
 * Behaviour:
 *   - Renders nothing when `kind === "none"` (no undraft has happened).
 *   - Renders "⏳ Review pending · check now" while waiting; polls the
 *     server every 30s and also exposes a manual Check button that
 *     triggers a poll on demand. The server side hits the GitHub PR
 *     comments, scrapes `REVIEW_RESULT`, and audits the verdict.
 *   - Once a verdict lands, switches to a coloured chip. Click for the
 *     blockers popover on P1 / P2_BLOCKER.
 *
 * We keep the initial state (server-rendered) and only update locally
 * when a poll returns a fresher verdict — no hydration mismatch risk.
 */
export function ReviewVerdictBadge({ taskId, initial }: Props) {
  const router = useRouter();
  const [state, setState] = useState<ReviewVerdictState>(initial);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/check-review`, {
        method: "POST",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { state: ReviewVerdictState };
      if (json.state && json.state.kind !== "none") {
        setState(json.state);
        // If the server just recorded a fresh verdict, re-render the page
        // so any sibling components (Jira status label, lane badges) see
        // the new audit row too.
        if (json.state.kind === "verdict" && initial.kind !== "verdict") {
          router.refresh();
        }
      }
    } finally {
      setChecking(false);
    }
  };

  // Poll while pending; stop once we have a verdict.
  useEffect(() => {
    if (state.kind !== "pending") return;
    const id = setInterval(check, 30_000);
    // Kick off an immediate check on mount so the user doesn't wait 30s
    // when landing on a card whose review finished while they were away.
    void check();
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, taskId]);

  if (state.kind === "none") return null;

  if (state.kind === "pending") {
    return (
      <div className="flex items-center gap-2">
        <Chip {...VERDICT_CHIP.pending} size="sm">
          ⏳ CI review pending
        </Chip>
        <Button
          {...BUTTON_INTENTS["retry"]}
          size="sm"
          onPress={check}
          isDisabled={checking}
        >
          {checking ? "checking…" : "check now"}
        </Button>
      </div>
    );
  }

  // verdict
  if (state.verdict === "PASS") {
    return (
      <Chip {...VERDICT_CHIP.PASS} size="sm">
        ✅ Review PASS
      </Chip>
    );
  }

  const severity = state.verdict === "P1" ? "P1 Critical" : "P2 Blocker";
  const verdictChip = state.verdict === "P1" ? VERDICT_CHIP.P1 : VERDICT_CHIP.P2_BLOCKER;
  return (
    <Popover>
      <PopoverTrigger>
        {/* Invisible button wrapper so Popover has a focusable trigger
            (React Aria requires this). The chip is the visible affordance. */}
        <button type="button" className="cursor-pointer">
          <Chip {...verdictChip} size="sm">
            ❌ Review {severity} — click for details
          </Chip>
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverDialog className="max-w-md p-3">
          <div className="mb-1 font-semibold text-red-800">
            Blocking issues ({severity})
          </div>
          {/*
            Render blockers as plain text children (NOT
            dangerouslySetInnerHTML) — blockers come from PR comments
            which could contain untrusted markdown. React escapes
            strings as children by default. Safe.
          */}
          {state.blockers ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-snug text-[color:var(--color-foreground)]">
              {state.blockers}
            </pre>
          ) : (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              See the PR review for details.
            </p>
          )}
        </PopoverDialog>
      </PopoverContent>
    </Popover>
  );
}
