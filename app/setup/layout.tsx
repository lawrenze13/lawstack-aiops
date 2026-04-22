import type { Metadata } from "next";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

export const metadata: Metadata = {
  title: "Setup — multiportal-ai-ops",
};

/**
 * Minimal chrome for the setup wizard. No sidebar, no board header —
 * the wizard is its own world while the instance is being bootstrapped.
 */
export default function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--background)]">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[color:var(--foreground)]">
            multiportal-ai-ops
          </span>
          <span className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-[color:var(--accent)]">
            first-run setup
          </span>
        </div>
        <ThemeToggle />
      </header>
      <main className="flex-1 flex justify-center p-6">
        <div className="w-full max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
