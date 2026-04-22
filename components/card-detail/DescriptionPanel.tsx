"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  descriptionMd: string;
  jiraKey: string;
  jiraUrl?: string;
};

/**
 * Sidebar section showing the Jira description. Designed to live alongside
 * RunSidebar and ArtifactPanel — scrolls independently within its own box.
 */
export function DescriptionPanel({ descriptionMd, jiraKey, jiraUrl }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-[color:var(--border)]">
      <div className="flex items-center justify-between border-b border-[color:var(--border)] px-3 py-2">
        <h2 className="text-sm font-semibold">Description</h2>
        {jiraUrl ? (
          <a
            href={jiraUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] text-[color:var(--muted)] hover:underline"
            title="Open in Jira"
          >
            {jiraKey} ↗
          </a>
        ) : (
          <span className="font-mono text-[10px] text-[color:var(--muted)]">
            {jiraKey}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {descriptionMd.trim() ? (
          <div className="prose prose-sm max-w-none whitespace-pre-wrap text-xs leading-relaxed text-[color:var(--foreground)] prose-pre:rounded prose-pre:bg-[color:var(--surface-secondary)] prose-pre:p-2 prose-pre:text-[11px] prose-code:text-[11px] prose-code:before:content-none prose-code:after:content-none prose-p:my-1.5 prose-headings:mt-2 prose-headings:mb-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{descriptionMd}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-[color:var(--muted)]">
            (No description on the Jira ticket.)
          </p>
        )}
      </div>
    </div>
  );
}
