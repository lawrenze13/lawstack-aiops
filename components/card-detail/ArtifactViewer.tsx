"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  kind: "brainstorm" | "plan" | "review";
  filename: string;
  markdown: string;
  isStale: boolean;
};

export function ArtifactViewer({ kind, filename, markdown, isStale }: Props) {
  const [copied, setCopied] = useState(false);

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
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase text-amber-800">
              stale
            </span>
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
          <div className="prose prose-sm max-w-none text-[color:var(--color-foreground)] prose-headings:text-[color:var(--color-foreground)] prose-strong:text-[color:var(--color-foreground)] prose-pre:rounded-md prose-pre:bg-[color:var(--color-muted)] prose-pre:p-3 prose-pre:text-xs prose-code:text-[12px] prose-code:before:content-none prose-code:after:content-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-h1:mt-4 prose-h1:mb-2 prose-h2:mt-4 prose-h2:mb-2 prose-h3:mt-3 prose-h3:mb-1.5 prose-blockquote:border-l-4 prose-blockquote:border-[color:var(--color-border)] prose-blockquote:pl-3 prose-blockquote:italic prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        </div>
      </article>
    </div>
  );
}
