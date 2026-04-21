"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

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

/**
 * Compact list of produced artifacts. Clicking an entry switches the main
 * pane tab to that artifact via the `?tab=` URL param — the full viewer
 * takes over the right column instead of expanding inline here.
 */
export function ArtifactPanel({ artifacts }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get("tab") ?? "log";

  if (artifacts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-3 text-xs text-[color:var(--color-muted-foreground)]">
        No artifacts produced yet. Run Brainstorm and Plan, then Approve & PR to ship.
      </div>
    );
  }

  const openTab = (kind: Artifact["kind"]) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", kind);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="rounded-lg border border-[color:var(--color-border)] p-3">
      <h2 className="mb-2 text-sm font-semibold">Artifacts</h2>
      <ul className="space-y-1.5">
        {artifacts.map((a) => {
          const isActive = activeTab === a.kind;
          return (
            <li key={a.kind}>
              <button
                type="button"
                onClick={() => openTab(a.kind)}
                className={`flex w-full items-center justify-between rounded border px-2.5 py-1.5 text-left text-xs transition ${
                  isActive
                    ? "border-blue-500/40 bg-blue-500/5"
                    : "border-[color:var(--color-border)] hover:border-blue-500/30 hover:bg-[color:var(--color-muted)]/40"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{KIND_LABEL[a.kind]}</span>
                  <span className="font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
                    {a.filename}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  {a.isStale ? (
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] uppercase text-amber-800">
                      stale
                    </span>
                  ) : null}
                  <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                    {isActive ? "open" : "view →"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
