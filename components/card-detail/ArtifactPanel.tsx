"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Artifact = {
  kind: "brainstorm" | "plan" | "review";
  filename: string;
  markdown: string;
  isStale: boolean;
  createdAt: number;
};

type Props = {
  artifacts: Artifact[];
};

const KIND_LABEL: Record<Artifact["kind"], string> = {
  brainstorm: "Brainstorm",
  plan: "Plan",
  review: "Review",
};

export function ArtifactPanel({ artifacts }: Props) {
  const [openKind, setOpenKind] = useState<Artifact["kind"] | null>(null);

  if (artifacts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-3 text-xs text-[color:var(--color-muted-foreground)]">
        No artifacts produced yet. Run Brainstorm and Plan, then Approve & PR to ship.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[color:var(--color-border)] p-3">
      <h2 className="mb-2 text-sm font-semibold">Artifacts</h2>
      <ul className="space-y-2">
        {artifacts.map((a) => {
          const open = openKind === a.kind;
          return (
            <li key={a.kind} className="rounded border border-[color:var(--color-border)]">
              <button
                type="button"
                onClick={() => setOpenKind(open ? null : a.kind)}
                className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-[color:var(--color-muted)]/40"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{KIND_LABEL[a.kind]}</span>
                  <span className="font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
                    {a.filename}
                  </span>
                  {a.isStale ? (
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] uppercase text-amber-800">
                      stale
                    </span>
                  ) : null}
                </span>
                <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  {open ? "hide" : "preview"}
                </span>
              </button>
              {open ? (
                <div className="prose prose-sm max-w-none border-t border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 px-3 py-2 text-xs prose-pre:my-1 prose-pre:rounded prose-pre:bg-[color:var(--color-muted)] prose-pre:p-2 prose-pre:text-[11px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.markdown}</ReactMarkdown>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
