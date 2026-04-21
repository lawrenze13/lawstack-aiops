"use client";

import { useState, type ReactNode } from "react";
import { ArtifactViewer } from "./ArtifactViewer";

export type CardArtifact = {
  kind: "brainstorm" | "plan" | "review";
  filename: string;
  markdown: string;
  isStale: boolean;
};

type TabId = "log" | CardArtifact["kind"];

type Props = {
  artifacts: CardArtifact[];
  logContent: ReactNode;
  chatContent: ReactNode;
};

const KIND_ORDER: CardArtifact["kind"][] = ["brainstorm", "plan", "review"];
const KIND_LABEL: Record<CardArtifact["kind"], string> = {
  brainstorm: "Brainstorm",
  plan: "Plan",
  review: "Review",
};

export function CardMainTabs({ artifacts, logContent, chatContent }: Props) {
  const [active, setActive] = useState<TabId>("log");

  const ordered = KIND_ORDER.map((k) => artifacts.find((a) => a.kind === k)).filter(
    (a): a is CardArtifact => !!a,
  );

  return (
    <div className="flex h-full flex-col rounded-lg border border-[color:var(--color-border)]">
      <div className="flex items-center gap-1 border-b border-[color:var(--color-border)] px-2 py-1.5 text-xs">
        <TabButton active={active === "log"} onClick={() => setActive("log")}>
          Run log
        </TabButton>
        {ordered.map((a) => (
          <TabButton
            key={a.kind}
            active={active === a.kind}
            onClick={() => setActive(a.kind)}
          >
            {KIND_LABEL[a.kind]}
            {a.isStale ? (
              <span className="ml-1 rounded bg-amber-500/20 px-1 py-0 text-[9px] uppercase text-amber-800">
                stale
              </span>
            ) : null}
          </TabButton>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {active === "log" ? (
          logContent
        ) : (
          (() => {
            const a = artifacts.find((x) => x.kind === active);
            if (!a) return null;
            return (
              <ArtifactViewer
                kind={a.kind}
                filename={a.filename}
                markdown={a.markdown}
                isStale={a.isStale}
              />
            );
          })()
        )}
      </div>

      {active === "log" ? chatContent : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-xs font-medium ${
        active
          ? "bg-[color:var(--color-foreground)] text-[color:var(--color-background)]"
          : "text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)]"
      }`}
    >
      {children}
    </button>
  );
}
