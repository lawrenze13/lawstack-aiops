// In-memory sliding-window rate limiter. Single-process only — fine for our
// single-VPS deployment. Scales naturally via the key you hash into (e.g.
// `${userId}:${runId}`). HMR-safe singleton.

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitBuckets: Map<string, number[]> | undefined;
}

const buckets: Map<string, number[]> =
  globalThis.__rateLimitBuckets ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__rateLimitBuckets = buckets;
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number; remaining: 0 };

/**
 * Check and record a request against a sliding window.
 *
 * - `key`   — composite identifier (e.g. `msg:${userId}:${runId}`).
 * - `limit` — max calls per window (e.g. 20).
 * - `windowMs` — window length (e.g. 60_000).
 *
 * Records the current timestamp on success. On failure, returns the
 * number of seconds until the window will have room.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = buckets.get(key) ?? [];
  // Drop timestamps outside the window.
  while (arr.length > 0 && (arr[0] as number) <= cutoff) arr.shift();

  if (arr.length >= limit) {
    const oldest = arr[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, arr); // save trimmed state
    return { ok: false, retryAfterSec, remaining: 0 };
  }

  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, remaining: limit - arr.length };
}

/** Drop a bucket completely — used when a run finalises so a new run's
 *  rate-limit isn't poisoned by the previous one's timestamps. */
export function clearBucket(key: string): void {
  buckets.delete(key);
}
