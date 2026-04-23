"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { SettingSection } from "@/server/lib/settingsSchema";
import { SettingsSectionForm } from "./SettingsSectionForm";

type Props = {
  sections: SettingSection[];
  initialValues: Record<string, unknown>;
};

/**
 * Tabbed settings navigator. Renders one horizontal strip of section
 * tabs at the top and only the active section's form below. Active tab
 * is driven by the `?section=<id>` query param so sections are
 * deep-linkable (bookmark/share a specific settings view).
 *
 * Defaults to the first section when the param is missing or unknown.
 */
export function SettingsTabs({ sections, initialValues }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const queryId = searchParams.get("section");
  const active =
    sections.find((s) => s.id === queryId) ?? sections[0];

  if (!active) return null;

  const setActive = (id: string) => {
    // Use router.replace so back button doesn't fill with tab clicks.
    const params = new URLSearchParams(searchParams.toString());
    params.set("section", id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      {/* Vertical nav rail — becomes a horizontal overflow strip on mobile. */}
      <nav aria-label="Settings sections" className="md:sticky md:top-6 md:self-start">
        <div className="mb-2 hidden font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)] md:block">
          sections
        </div>
        <div className="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5 md:overflow-visible">
          {sections.map((s) => {
            const isActive = s.id === active.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                aria-current={isActive ? "page" : undefined}
                className={`group relative flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-xs font-medium transition-colors md:whitespace-normal ${
                  isActive
                    ? "bg-[color:var(--surface-secondary)] text-[color:var(--foreground)]"
                    : "text-[color:var(--muted)] hover:bg-[color:var(--surface-secondary)]/60 hover:text-[color:var(--foreground)]"
                }`}
              >
                <span
                  aria-hidden
                  className={`font-mono text-[10px] uppercase tracking-[0.12em] ${
                    isActive
                      ? "text-[color:var(--accent)]"
                      : "text-[color:var(--muted)]"
                  }`}
                >
                  {sectionIndex(sections, s.id)}
                </span>
                <span className="flex-1">{s.title}</span>
                {isActive ? (
                  <span
                    aria-hidden
                    className="hidden h-4 w-0.5 rounded-full bg-[color:var(--accent)] md:block"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Active section form */}
      <div className="min-w-0">
        <SettingsSectionForm
          key={active.id}
          section={active}
          initialValues={initialValues}
        />
      </div>
    </div>
  );
}

function sectionIndex(sections: SettingSection[], id: string): string {
  const idx = sections.findIndex((s) => s.id === id);
  if (idx < 0) return "";
  return String(idx + 1).padStart(2, "0");
}
