import { describe, expect, it } from "vitest";
import { decideExitStatus } from "@/server/worker/exitStatus";

// Tests the exit-status classifier that turned out to be the source of
// the worst NEEDS_INPUT bug: Claude CLI traps SIGTERM and exits with
// code 143 + signal=null, so we had to widen the logic past the
// signal-only check that shipped originally.

describe("decideExitStatus — stopReason priority", () => {
  it("cost_cap always wins → cost_killed", () => {
    expect(decideExitStatus(0, null, "cost_cap")).toBe("cost_killed");
    expect(decideExitStatus(143, "SIGTERM", "cost_cap")).toBe("cost_killed");
    expect(decideExitStatus(null, "SIGKILL", "cost_cap")).toBe("cost_killed");
  });

  it("user-requested stop → stopped regardless of exit", () => {
    // Even if the child somehow exits with code 0 after SIGTERM (which
    // would otherwise classify as completed), stopReason=user takes over.
    // This is the belt-and-braces path for the 10s NEEDS_INPUT grace
    // window.
    expect(decideExitStatus(0, null, "user")).toBe("stopped");
    expect(decideExitStatus(143, null, "user")).toBe("stopped");
    expect(decideExitStatus(null, "SIGTERM", "user")).toBe("stopped");
  });
});

describe("decideExitStatus — trapped-signal exit codes", () => {
  it("code 143 (128 + SIGTERM) → stopped even when signal is null", () => {
    // The original bug: Claude CLI catches SIGTERM, cleans up, exits
    // cleanly with 143. Node reports code=143, signal=null. Old logic
    // required signal==='SIGTERM' → fell through to 'failed'.
    expect(decideExitStatus(143, null)).toBe("stopped");
  });

  it("code 137 (128 + SIGKILL) → stopped", () => {
    expect(decideExitStatus(137, null)).toBe("stopped");
  });
});

describe("decideExitStatus — signal-based exits", () => {
  it("SIGTERM signal → stopped", () => {
    expect(decideExitStatus(null, "SIGTERM")).toBe("stopped");
  });
  it("SIGKILL signal → stopped", () => {
    expect(decideExitStatus(null, "SIGKILL")).toBe("stopped");
  });
});

describe("decideExitStatus — natural exits", () => {
  it("code 0 → completed", () => {
    expect(decideExitStatus(0, null)).toBe("completed");
  });

  it("non-zero, non-signal-derived code → failed", () => {
    expect(decideExitStatus(1, null)).toBe("failed");
    expect(decideExitStatus(2, null)).toBe("failed");
    expect(decideExitStatus(255, null)).toBe("failed");
  });

  it("null code + null signal → failed (unknown)", () => {
    // Should never happen in practice but we fall to 'failed' rather
    // than misreport 'completed'.
    expect(decideExitStatus(null, null)).toBe("failed");
  });
});
