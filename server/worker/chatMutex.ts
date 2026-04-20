// Tiny per-run async mutex. Two tabs posting chat for the same run will
// serialise through this — we must not call `claude --resume <id>` twice
// concurrently for the same session, since Claude treats each resume as a
// new turn and the filesystem/worktree would race.

declare global {
  // eslint-disable-next-line no-var
  var __runMutexes: Map<string, Promise<void>> | undefined;
}

const locks: Map<string, Promise<void>> = globalThis.__runMutexes ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__runMutexes = locks;
}

/**
 * Run fn() serialised per-key. Returns fn's result. Safe to call from many
 * concurrent route handlers — the second caller awaits the first.
 */
export async function withRunLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  // Chain: my slot starts when the prior slot finishes.
  const next = prior.then(() => mine);
  locks.set(key, next);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    // Clean up if we're still the latest in the chain (prevents memory leak
    // when no one else queues behind us).
    if (locks.get(key) === next) locks.delete(key);
  }
}
