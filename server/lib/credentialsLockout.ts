// Consecutive-failure lockout for credential test endpoints. Layered
// ON TOP of the rate limiter — distinct concern.
//
//   - rateLimit:  X tests per minute per (user, service). Stops bursts.
//   - lockout:    X CONSECUTIVE failed tests in 1h locks for 30 min.
//                 Stops slow credential-stuffing.
//
// Per OWASP ASVS V11.1.2 — anti-automation. Reset on first success.
//
// In-memory only — single-process deployment is the assumption. HMR-safe
// via globalThis pin. Phase 5 surfaces lockouts on /admin/ops if needed.

declare global {
  // eslint-disable-next-line no-var
  var __credentialsLockoutState:
    | Map<string, { failures: number; lastFailAt: number }>
    | undefined;
}

const state: Map<string, { failures: number; lastFailAt: number }> =
  globalThis.__credentialsLockoutState ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__credentialsLockoutState = state;
}

const FAILURE_WINDOW_MS = 60 * 60 * 1000; // 1h
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 min

export type LockoutCheck =
  | { locked: false }
  | { locked: true; retryAfterSec: number };

function key(userId: string, service: string): string {
  return `${userId}:${service}`;
}

/**
 * Check if a user/service pair is currently locked out. Call BEFORE
 * dispatching to the test handler. Returns retry-after seconds when
 * locked, or `{locked:false}` when allowed.
 */
export function checkLockout(userId: string, service: string): LockoutCheck {
  const entry = state.get(key(userId, service));
  if (!entry) return { locked: false };
  if (entry.failures < LOCKOUT_THRESHOLD) return { locked: false };

  const lockedUntil = entry.lastFailAt + LOCKOUT_DURATION_MS;
  const remainingMs = lockedUntil - Date.now();
  if (remainingMs <= 0) {
    // Lockout expired — clear and allow.
    state.delete(key(userId, service));
    return { locked: false };
  }
  return { locked: true, retryAfterSec: Math.ceil(remainingMs / 1000) };
}

/**
 * Record a test failure. Call AFTER the handler returned `ok: false`.
 * Failures outside the 1h sliding window decay (we reset the counter
 * if the last failure was over an hour ago).
 */
export function recordFailure(userId: string, service: string): void {
  const k = key(userId, service);
  const now = Date.now();
  const entry = state.get(k);
  if (!entry || now - entry.lastFailAt > FAILURE_WINDOW_MS) {
    state.set(k, { failures: 1, lastFailAt: now });
  } else {
    state.set(k, { failures: entry.failures + 1, lastFailAt: now });
  }
}

/**
 * Record a test success. Call AFTER the handler returned `ok: true`.
 * Resets the failure counter so future lockouts don't carry stale state.
 */
export function recordSuccess(userId: string, service: string): void {
  state.delete(key(userId, service));
}

/** Test-only — clear all in-memory state. */
export function __resetLockoutForTest(): void {
  state.clear();
}
