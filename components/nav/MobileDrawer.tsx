"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { IconBurger, IconX } from "./SidebarIcons";

type Props = {
  /** Pre-rendered sidebar (server component passed via children). */
  children: React.ReactNode;
};

/**
 * Off-canvas drawer that wraps the Sidebar on viewports <lg (1024px).
 *
 * Structure: the overlay is always portalled to document.body — we
 * only toggle its visibility + animation via `open`. Portalling
 * escapes backdrop-filter ancestors (like the mobile top-bar) that
 * would otherwise trap position:fixed elements inside them.
 */
export function MobileDrawer({ children }: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMounted(true), []);

  // Close when the user navigates to a new route.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Esc; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
      aria-hidden={!open}
      className="fixed inset-0 z-[70] lg:hidden"
      style={{
        pointerEvents: open ? "auto" : "none",
        visibility: open ? "visible" : "hidden",
      }}
    >
      <button
        type="button"
        aria-label="Close navigation"
        onClick={close}
        tabIndex={open ? 0 : -1}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        style={{
          opacity: open ? 1 : 0,
          transition: "opacity 150ms ease-out",
        }}
      />
      <div
        className="absolute left-0 top-0 flex h-full w-64 max-w-[85vw] flex-col bg-[color:var(--surface)] shadow-xl"
        style={{
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 180ms ease-out",
        }}
      >
        <div className="flex items-center justify-end border-b border-[color:var(--border)] px-2 py-2">
          <button
            type="button"
            onClick={close}
            aria-label="Close navigation"
            tabIndex={open ? 0 : -1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[color:var(--muted)] hover:bg-[color:var(--surface-secondary)]/60 hover:text-[color:var(--foreground)]"
          >
            <IconX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="relative z-[60] inline-flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
      >
        <IconBurger />
      </button>
      {mounted ? createPortal(overlay, document.body) : null}
    </>
  );
}
