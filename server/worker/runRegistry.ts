import type { ChildProcess } from "node:child_process";

// In-process registry of live `claude` child processes, keyed by run_id.
// Survives only as long as the Node process; on crash/restart the boot
// reconciler marks any DB row still `running` as `interrupted` (Phase 2B).

declare global {
  // eslint-disable-next-line no-var
  var __runRegistry: Map<string, RunHandle> | undefined;
}

export type StopReason = "user" | "cost_cap" | "shutdown";

export type RunHandle = {
  runId: string;
  taskId: string;
  child: ChildProcess;
  startedAt: number;
  /** Graceful stop: SIGTERM then SIGKILL after 5s. */
  stop: (reason: StopReason) => void;
};

export const runRegistry: Map<string, RunHandle> =
  globalThis.__runRegistry ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__runRegistry = runRegistry;
}

/** Number of currently live children. Cheap; useful for the admin ops page. */
export function liveRunCount(): number {
  return runRegistry.size;
}
