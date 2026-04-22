"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type Props = {
  href: string;
  icon: ReactNode;
  label: string;
  /** Exact-match only; parent routes don't light up when a child is active. */
  exact?: boolean;
};

/**
 * Single sidebar navigation item. Highlights when the current pathname
 * matches {href} (exact or prefix). Uses aria-current="page" for a11y.
 */
export function SidebarItem({ href, icon, label, exact = false }: Props) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-[color:var(--surface-secondary)] text-[color:var(--foreground)]"
          : "text-[color:var(--muted)] hover:bg-[color:var(--surface-secondary)]/60 hover:text-[color:var(--foreground)]"
      }`}
    >
      <span
        className={`inline-flex h-4 w-4 items-center justify-center ${
          active ? "text-[color:var(--accent)]" : "text-[color:var(--muted)] group-hover:text-[color:var(--foreground)]"
        }`}
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}
