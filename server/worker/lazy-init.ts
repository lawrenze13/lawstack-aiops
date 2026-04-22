// Lazy boot init triggered by the first server-side import. Runs the crash
// reconciler exactly once per physical process. Imported by the DB client.
//
// The `initialised` flag lives on globalThis so Next.js dev HMR — which
// can re-evaluate this module when dependencies change — does NOT re-run
// the reconciler and stomp on runs that are alive in the current process.

import { reconcileInterruptedRuns } from "./reconcile";
import { ensureSetupToken } from "@/server/auth/setupToken";

declare global {
  // eslint-disable-next-line no-var
  var __aiopsInitialised: boolean | undefined;
}

export function ensureInitialised(): void {
  if (globalThis.__aiopsInitialised) return;
  globalThis.__aiopsInitialised = true;
  // First-run setup token check. Async; we fire and log — the CLI banner
  // prints from inside ensureSetupToken(), not from its return value.
  ensureSetupToken().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[lazy-init] setup-token ensure failed", err);
  });
  try {
    reconcileInterruptedRuns();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[lazy-init] reconcile failed", err);
  }
}
