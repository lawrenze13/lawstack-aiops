import type { StopReason } from "./runRegistry";

/**
 * Pure classifier for child-process exit → run status. Extracted from
 * spawnAgent so it can be unit-tested without pulling in the DB +
 * better-sqlite3 native bindings.
 *
 * The matrix it encodes (and WHY each rule exists):
 *
 *   stopReason=cost_cap       → cost_killed   (cost meter tripped kill cap)
 *   stopReason=user           → stopped       (user-requested stop, e.g. Stop
 *                                              button or mid-stream NEEDS_INPUT
 *                                              SIGTERM — MUST NOT be misreported
 *                                              as 'failed' when the child
 *                                              trapped SIGTERM and exited 143)
 *   signal=SIGTERM|SIGKILL    → stopped       (ordinary signal-killed exit)
 *   code=143 or code=137      → stopped       (128 + signum — Claude CLI
 *                                              traps SIGTERM and exits 143
 *                                              cleanly with signal=null)
 *   code=0                    → completed
 *   anything else             → failed
 *
 * Used in spawnAgent's child.on('exit') handler; the resulting status
 * may be further upgraded to 'awaiting_input' when a NEEDS_INPUT marker
 * was seen during the stream.
 */
export function decideExitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
  stopReason?: StopReason,
): "completed" | "failed" | "stopped" | "cost_killed" | "awaiting_input" {
  if (stopReason === "cost_cap") return "cost_killed";
  if (stopReason === "user") return "stopped";
  if (signal === "SIGTERM" || signal === "SIGKILL") return "stopped";
  if (code === 143 || code === 137) return "stopped";
  if (code === 0) return "completed";
  return "failed";
}
