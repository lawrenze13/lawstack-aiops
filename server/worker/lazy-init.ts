// Lazy boot init triggered by the first server-side import. Runs the crash
// reconciler exactly once per process lifetime. Imported by the DB client
// on first use so it sits behind the same load-bearing module.

import { reconcileInterruptedRuns } from "./reconcile";

let initialised = false;

export function ensureInitialised(): void {
  if (initialised) return;
  initialised = true;
  try {
    reconcileInterruptedRuns();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[lazy-init] reconcile failed", err);
  }
}
