"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Thin top-of-page progress stripe, YouTube/GitHub-style. Gives
 * instant feedback on every in-app navigation.
 *
 * Why two triggers:
 *   - usePathname / useSearchParams only change AFTER Next.js commits
 *     the navigation — that's too late for "did my click register?"
 *     feedback on a fresh route whose server component is still
 *     rendering.
 *   - A document-level click listener catches the click the moment
 *     the user releases the burger/tab/link, starts the stripe,
 *     and lets the effect below drive it to completion when
 *     Next.js eventually commits the route.
 *
 * Ignores:
 *   - External links (different origin, target=_blank, download)
 *   - Modified clicks (cmd/ctrl/shift/alt/middle — user wants a new tab)
 *   - Same-URL clicks (no navigation happens)
 *   - Form submits, buttons, etc. (only anchor tags drive App-Router
 *     navigation visibly enough to warrant a progress stripe)
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  };

  const start = () => {
    clearTimers();
    setVisible(true);
    setProgress(10);
    // Creep up slowly while the server renders the target page. We
    // don't know how long it'll take, so we trickle up asymptotically.
    timers.current.push(window.setTimeout(() => setProgress(35), 100));
    timers.current.push(window.setTimeout(() => setProgress(60), 300));
    timers.current.push(window.setTimeout(() => setProgress(80), 700));
    timers.current.push(window.setTimeout(() => setProgress(90), 1500));
  };

  const complete = () => {
    clearTimers();
    setProgress(100);
    timers.current.push(
      window.setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 200),
    );
  };

  // ── Trigger 1: immediate click feedback via document-level listener
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Skip modified clicks (new tab / window / etc.)
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
        return;
      }
      const target = (e.target as HTMLElement | null)?.closest("a");
      if (!target) return;
      const anchor = target as HTMLAnchorElement;
      // Skip external / download / target=_blank
      if (
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        anchor.origin !== window.location.origin
      ) {
        return;
      }
      // Skip same-URL clicks (hash-only change also fine — router replaces).
      const samePath =
        anchor.pathname === window.location.pathname &&
        anchor.search === window.location.search;
      if (samePath) return;
      start();
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
    // No deps — handlers read latest state via closure-over-refs.
  }, []);

  // ── Trigger 2: complete when pathname/searchParams change
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    complete();
    return clearTimers;
  }, [pathname, searchParams]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 150ms ease-out" }}
    >
      <div
        className="h-full bg-[color:var(--accent)] shadow-[0_0_8px_var(--accent)]"
        style={{
          width: `${progress}%`,
          transition: "width 180ms ease-out",
        }}
      />
    </div>
  );
}
