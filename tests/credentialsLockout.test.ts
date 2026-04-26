import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  __resetLockoutForTest,
  checkLockout,
  recordFailure,
  recordSuccess,
} from "@/server/lib/credentialsLockout";

beforeEach(() => {
  __resetLockoutForTest();
});

describe("credentialsLockout", () => {
  it("returns locked: false on a fresh (user, service) pair", () => {
    expect(checkLockout("u1", "jira").locked).toBe(false);
  });

  it("does not lock under threshold (4 failures)", () => {
    for (let i = 0; i < 4; i++) recordFailure("u1", "jira");
    expect(checkLockout("u1", "jira").locked).toBe(false);
  });

  it("locks at exactly 5 consecutive failures", () => {
    for (let i = 0; i < 5; i++) recordFailure("u1", "jira");
    const r = checkLockout("u1", "jira");
    expect(r.locked).toBe(true);
    if (r.locked) {
      // 30 min lockout — retry-after is in (0, 1800] seconds.
      expect(r.retryAfterSec).toBeGreaterThan(0);
      expect(r.retryAfterSec).toBeLessThanOrEqual(30 * 60);
    }
  });

  it("recordSuccess clears the failure counter", () => {
    for (let i = 0; i < 4; i++) recordFailure("u1", "jira");
    recordSuccess("u1", "jira");
    // Now under threshold again — should accept 4 more before locking.
    for (let i = 0; i < 4; i++) recordFailure("u1", "jira");
    expect(checkLockout("u1", "jira").locked).toBe(false);
  });

  it("isolates state per (userId, service)", () => {
    for (let i = 0; i < 5; i++) recordFailure("u1", "jira");
    expect(checkLockout("u1", "jira").locked).toBe(true);
    expect(checkLockout("u1", "github").locked).toBe(false);
    expect(checkLockout("u2", "jira").locked).toBe(false);
  });

  it("clears stale state when the lockout window expires", () => {
    // Fast-forward time by lockout-duration + 1s after locking.
    for (let i = 0; i < 5; i++) recordFailure("u1", "jira");
    expect(checkLockout("u1", "jira").locked).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(checkLockout("u1", "jira").locked).toBe(false);
    vi.useRealTimers();
  });

  it("resets the failure counter when failures decay (>1h since last)", () => {
    recordFailure("u1", "jira");
    recordFailure("u1", "jira");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 65 * 60 * 1000);
    // Next failure starts a fresh count.
    recordFailure("u1", "jira");
    expect(checkLockout("u1", "jira").locked).toBe(false);
    vi.useRealTimers();
  });
});
