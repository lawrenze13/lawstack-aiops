"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
      <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800">
        <span>⏳ CI review pending</span>
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] hover:bg-amber-500/20 disabled:opacity-50"
        >
          {checking ? "checking…" : "check now"}
        </button>
      </div>
    );
  }

  // verdict
  if (state.verdict === "PASS") {
    return (
      <span
        className="rounded-md border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-800"
        title="CI reviewer passed — Jira transitioned to Ready for QA"
      >
        ✅ Review PASS
      </span>
    );
  }

  const severity =
    state.verdict === "P1" ? "P1 Critical" : "P2 Blocker";
  return (
    <details className="group">
      <summary
        className="cursor-pointer list-none rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-500/20"
        title="Click to view blocking issues"
      >
        ❌ Review {severity} — click for details
      </summary>
      <div className="absolute mt-1 max-w-md rounded-md border border-red-500/40 bg-[color:var(--color-card)] p-3 text-xs shadow-lg">
        <div className="mb-1 font-semibold text-red-800">
          Blocking issues ({severity})
        </div>
        {state.blockers ? (
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-snug text-[color:var(--color-foreground)]">
            {state.blockers}
          </pre>
        ) : (
          <p className="text-[color:var(--color-muted-foreground)]">
            See the PR review for details.
          </p>
        )}
      </div>
    </details>
  );
}
