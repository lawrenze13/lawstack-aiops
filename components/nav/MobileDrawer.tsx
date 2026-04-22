"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { IconBurger, IconX } from "./SidebarIcons";

type Props = {
  /** Pre-rendered sidebar (server component passed via children). */
  children: React.ReactNode;
};

/**
 * Off-canvas drawer that wraps the Sidebar on viewports <lg (1024px).
 * The sidebar markup is passed as {children} from a server boundary so
 * the role-aware SSR output is preserved; this component only handles
 * the open/close state + Esc/backdrop behaviour.
 *
 * Uses a plain <dialog> element to get accessible focus handling and
 * the native ::backdrop pseudo. Avoids HeroUI's Dialog which conflicts
 * with our <main> layout.
 */
export function MobileDrawer({ children }: Props) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close when the user navigates to a new route.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Esc, lock scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--muted)] hover:text-[color:var(--foreground)] lg:hidden"
      >
        <IconBurger />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          />
          <div className="absolute left-0 top-0 flex h-full w-60 max-w-[85vw] animate-[slideIn_150ms_ease-out] flex-col bg-[color:var(--surface)] shadow-xl">
            <div className="flex items-center justify-end border-b border-[color:var(--border)] px-2 py-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[color:var(--muted)] hover:bg-[color:var(--surface-secondary)]/60 hover:text-[color:var(--foreground)]"
              >
                <IconX />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(-100%); }
          to   { transform: translateX(0); }
        }
      `}</style>
    </>
  );
}
