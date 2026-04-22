// Next.js boot hook. Runs once per server start.
//
// Responsibilities:
//   1. First-run setup: if the `users` table is empty AND no `setup_tokens`
//      row exists yet, generate a UUID, persist it, and log the setup URL
//      to stdout. That URL bypasses auth for /setup* routes (see
//      middleware.ts + server/auth/setupToken.ts) so the first operator
//      can configure Google OAuth before any user account exists.
//   2. (pre-existing) no-op console log so the runtime is audible.
//
// DB access is restricted to NEXT_RUNTIME === "nodejs" to avoid webpack
// bundling better-sqlite3 for the Edge variant.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // eslint-disable-next-line no-console
  console.log("[multiportal-ai-ops] Node runtime up");

  // Dynamic import so Edge / browser bundles never see drizzle + sqlite.
  const { ensureSetupToken } = await import("@/server/auth/setupToken");
  try {
    await ensureSetupToken();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[setup-token] failed to check/generate token:", err);
  }
}
