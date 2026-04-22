import type { Metadata } from "next";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Brandmark } from "@/components/brand/Brandmark";

export const metadata: Metadata = {
  title: "Setup — LawStack/aiops",
};

export default function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--background)]">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--background)]/80 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Brandmark size={24} />
          <span className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--accent)]">
            first-run setup
          </span>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 justify-center p-6">
        <div className="w-full max-w-3xl">{children}</div>
      </main>

      <footer className="border-t border-[color:var(--border)] px-6 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
        <div className="flex items-center justify-between">
          <span>lawstack/aiops · bootstrap mode</span>
          <span className="flex items-center gap-2">
            <span className="relative inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent)]" />
              <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-[color:var(--accent)] opacity-75" />
            </span>
            orchestrator online
          </span>
        </div>
      </footer>
    </div>
  );
}
