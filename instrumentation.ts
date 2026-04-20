// Next.js boot hook. Kept intentionally lean — DB-touching logic (migrations,
// crash-recovery reconciler) cannot live here because webpack bundles
// instrumentation.ts for both Node and Edge variants and chokes on
// better-sqlite3's native binding (`fs`, `path` are Node-only).
//
// Migrations are a deploy-time concern: `npm run db:migrate` runs as systemd
// `ExecStartPre`. Phase 2's runRegistry reconcile fires lazily on first
// access to the registry singleton (see server/worker/runRegistry.ts).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // eslint-disable-next-line no-console
  console.log("[multiportal-ai-ops] Node runtime up");
}
