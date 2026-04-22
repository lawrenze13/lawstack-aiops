"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArtifactViewer } from "./ArtifactViewer";
import { ChangesViewer } from "./ChangesViewer";
import { DevShell } from "./DevShell";

export type CardArtifact = {
  kind: "brainstorm" | "plan" | "review" | "implementation";
  filename: string;
  markdown: string;
  isStale: boolean;
};

type TabId = "log" | CardArtifact["kind"] | "changes" | "shell";

const ARTIFACT_KINDS: CardArtifact["kind"][] = [
  "brainstorm",
  "plan",
  "review",
  "implementation",
];
function isArtifactKind(v: string | null): v is CardArtifact["kind"] {
  return !!v && (ARTIFACT_KINDS as string[]).includes(v);
}

type Props = {
  artifacts: CardArtifact[];
  logContent: ReactNode;
  chatContent: ReactNode;
  /** Task id — used by the Changes tab to fetch the diff. */
  taskId: string;
  /** Show the Changes tab only when a worktree with commits exists. */
  showChanges: boolean;
  /**
   * Show the Dev Shell tab. Only true when PREVIEW_DEV_ENABLE_SHELL=true
   * AND the viewer is the owner/admin. `shellCwd` is shown as the prompt
   * cwd; commands execute there server-side.
   */
  showShell: boolean;
  shellCwd?: string | null;
  shellCanControl?: boolean;
};

const KIND_ORDER: CardArtifact["kind"][] = [
  "brainstorm",
  "plan",
  "review",
  "implementation",
];
const KIND_LABEL: Record<CardArtifact["kind"], string> = {
  brainstorm: "Brainstorm",
  plan: "Plan",
  review: "Review",
  implementation: "Implementation",
};

export function CardMainTabs({
  artifacts,
  logContent,
  chatContent,
  taskId,
  showChanges,
  showShell,
  shellCwd,
  shellCanControl,
}: Props) {
  // Tab state is local-only. Initial state is always "log" (matches the
  // SSR render so we don't get a hydration mismatch when the URL has
  // ?tab=plan on a cold load). After mount we read the URL and align.
  // Clicks update state + URL via history.replaceState — NOT
  // router.replace, because that re-runs the server component and its
  // DB queries on every tab switch, making the UI feel laggy.
  const [active, setActiveState] = useState<TabId>("log");

  useEffect(() => {
    setActiveState(resolveInitialTab(showChanges, showShell));
    const onPop = () => {
      setActiveState(resolveInitialTab(showChanges, showShell));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [showChanges, showShell]);

  const setActive = (next: TabId) => {
    setActiveState(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "log") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    // replaceState updates the URL bar without triggering the Next.js
    // router — no server re-render, no DB queries, instant tab switch.
    window.history.replaceState(null, "", newUrl);
  };

  const ordered = KIND_ORDER.map((k) => artifacts.find((a) => a.kind === k)).filter(
    (a): a is CardArtifact => !!a,
  );

  const activeArtifact =
    active === "log" || active === "changes"
      ? null
      : artifacts.find((a) => a.kind === active);

  return (
    <div className="flex h-full flex-col rounded-lg border border-[color:var(--color-border)]">
      <div
        key="tabs"
        className="flex items-center gap-1 border-b border-[color:var(--color-border)] px-2 py-1.5 text-xs"
      >
        <TabButton key="log" active={active === "log"} onClick={() => setActive("log")}>
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
        {showChanges ? (
          <TabButton
            key="changes"
            active={active === "changes"}
            onClick={() => setActive("changes")}
          >
            Changes
          </TabButton>
        ) : null}
        {showShell ? (
          <TabButton
            key="shell"
            active={active === "shell"}
            onClick={() => setActive("shell")}
          >
            Dev Shell
          </TabButton>
        ) : null}
      </div>

      <div key="pane" className="min-h-0 flex-1 overflow-hidden">
        {/*
          logContent stays MOUNTED across tab switches — unmounting it
          tears down RunLog's SSE connection and makes its toast effects
          re-fire when you come back. We toggle visibility via CSS
          instead so state + subscribers are preserved.
        */}
        <div
          key="log-pane"
          className={`h-full ${active === "log" ? "block" : "hidden"}`}
        >
          {logContent}
        </div>
        {active === "changes" ? <ChangesViewer taskId={taskId} /> : null}
        {active === "shell" ? (
          <DevShell
            taskId={taskId}
            canControl={!!shellCanControl}
            cwd={shellCwd ?? "(unset)"}
          />
        ) : null}
        {activeArtifact ? (
          <ArtifactViewer
            kind={activeArtifact.kind}
            filename={activeArtifact.filename}
            markdown={activeArtifact.markdown}
            isStale={activeArtifact.isStale}
          />
        ) : null}
      </div>

      {/* Chat stays mounted for the same reason — unmount/remount would
          drop the ChatBox's local SSE subscription. Hidden via CSS when
          we're not on the Run log tab. */}
      <div
        key="chat-slot"
        className={active === "log" ? "block" : "hidden"}
      >
        {chatContent}
      </div>
    </div>
  );
}

function resolveInitialTab(showChanges: boolean, showShell: boolean): TabId {
  if (typeof window === "undefined") return "log";
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (isArtifactKind(tab)) return tab;
  if (tab === "changes" && showChanges) return "changes";
  if (tab === "shell" && showShell) return "shell";
  return "log";
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
