// Next.js boot hook. Kept intentionally lean — DB-touching logic (migrations,
// crash-recovery reconciler, setup-token ensure) cannot live here because
// webpack bundles instrumentation.ts for both Node and Edge variants and
// chokes on better-sqlite3's native binding (`fs`, `path` are Node-only).
//
// DB work piggy-backs on the lazy-init hook fired from server/db/client.ts
// (Node-only path). See server/worker/lazy-init.ts.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // eslint-disable-next-line no-console
  console.log("[lawstack-aiops] Node runtime up");
}
