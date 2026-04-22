"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Chip } from "@heroui/react/chip";

type Props = {
  kind: "brainstorm" | "plan" | "review" | "implementation";
  filename: string;
  markdown: string;
  isStale: boolean;
};

function extractVerdict(md: string): "READY" | "AMEND" | "REWRITE" | null {
  const m = md.match(/\*\*(READY|AMEND|REWRITE)\*\*/);
  return m ? (m[1] as "READY" | "AMEND" | "REWRITE") : null;
}

export function ArtifactViewer({ kind, filename, markdown, isStale }: Props) {
  const [copied, setCopied] = useState(false);
  const verdict = useMemo(
    () => (kind === "review" ? extractVerdict(markdown) : null),
    [kind, markdown],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            {kind}
          </span>
          <span className="font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
            {filename}
          </span>
          {isStale ? (
            <Chip color="warning" variant="soft" size="sm" className="uppercase text-[9px]">
              stale
            </Chip>
          ) : null}
          <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
            {markdown.length.toLocaleString()} chars
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] hover:bg-[color:var(--color-muted)]"
          >
            {copied ? "Copied!" : "Copy markdown"}
          </button>
        </div>
      </div>

      <article className="flex-1 overflow-y-auto bg-[color:var(--color-background)]">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {verdict === "AMEND" ? (
            <div className="mb-4 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900">
              <span className="text-base">⚠</span>
              <div>
                <div className="font-semibold">Verdict: AMEND — the plan needs fixes</div>
                <div className="mt-0.5 text-[11px]">
                  The review found specific issues in the Plan that should be corrected before
                  shipping. Read the <strong>Incorrect or stale</strong> and{" "}
                  <strong>Missing</strong> sections below, then use the{" "}
                  <strong>⇡ Amend Plan from Review</strong> button in the card header to
                  auto-regenerate the Plan addressing each finding.
                </div>
              </div>
            </div>
          ) : null}
          {verdict === "REWRITE" ? (
            <div className="mb-4 flex items-start gap-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-900">
              <span className="text-base">✘</span>
              <div>
                <div className="font-semibold">Verdict: REWRITE — the plan needs a fresh start</div>
                <div className="mt-0.5 text-[11px]">
                  The review found fundamental issues that require regenerating the Plan. Use the{" "}
                  <strong>⇡ Rewrite Plan from Review</strong> button in the card header, then
                  re-run Review to validate the new Plan.
                </div>
              </div>
            </div>
          ) : null}
          {verdict === "READY" ? (
            <div className="mb-4 flex items-start gap-3 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs text-green-900">
              <span className="text-base">✓</span>
              <div>
                <div className="font-semibold">Verdict: READY — plan is correct and complete</div>
                <div className="mt-0.5 text-[11px]">
                  The review validated every claim in the Plan against the real code. Click{" "}
                  <strong>✓ Approve &amp; PR</strong> in the card header to ship it.
                </div>
              </div>
            </div>
          ) : null}
          {kind === "review" && verdict === null ? (
            <div className="mb-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
              No explicit verdict found in this review. Look for <code>**READY**</code>,{" "}
              <code>**AMEND**</code>, or <code>**REWRITE**</code> as the closing bolded keyword.
            </div>
          ) : null}
          <div className="prose prose-sm max-w-none text-[color:var(--color-foreground)] prose-headings:text-[color:var(--color-foreground)] prose-strong:text-[color:var(--color-foreground)] prose-pre:rounded-md prose-pre:bg-[color:var(--color-muted)] prose-pre:p-3 prose-pre:text-xs prose-code:text-[12px] prose-code:before:content-none prose-code:after:content-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-h1:mt-4 prose-h1:mb-2 prose-h2:mt-4 prose-h2:mb-2 prose-h3:mt-3 prose-h3:mb-1.5 prose-blockquote:border-l-4 prose-blockquote:border-[color:var(--color-border)] prose-blockquote:pl-3 prose-blockquote:italic prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        </div>
      </article>
    </div>
  );
}
