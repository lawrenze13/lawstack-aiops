"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Thin wrapper around next-themes's ThemeProvider so the root layout
 * can stay a Server Component. next-themes injects a pre-hydration
 * `<script>` that reads localStorage / prefers-color-scheme and sets
 * `html.dark` BEFORE React hydrates — eliminates the light→dark strobe
 * on cold loads.
 *
 * `attribute="class"` puts the theme on `html.dark` (matches HeroUI v3's
 * class-based theme switching and our `@custom-variant dark (&:where(.dark, .dark *))`
 * in globals.css).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
