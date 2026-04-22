"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Chip } from "@heroui/react/chip";

type Artifact = {
  kind: "brainstorm" | "plan" | "review" | "implementation";
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
  implementation: "Implementation",
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
      <div className="rounded-lg border border-dashed border-[color:var(--border)] p-3 text-xs text-[color:var(--muted)]">
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
    <div className="rounded-lg border border-[color:var(--border)] p-3">
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
                    : "border-[color:var(--border)] hover:border-blue-500/30 hover:bg-[color:var(--surface-secondary)]/40"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{KIND_LABEL[a.kind]}</span>
                  <span className="font-mono text-[10px] text-[color:var(--muted)]">
                    {a.filename}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  {a.isStale ? (
                    <Chip color="warning" variant="soft" size="sm" className="uppercase text-[9px]">
                      stale
                    </Chip>
                  ) : null}
                  <span className="text-[10px] text-[color:var(--muted)]">
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
