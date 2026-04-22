import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Server-side code only — no browser DOM needed.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Keep tests fast: no file watching during CI, short timeouts.
    testTimeout: 10_000,
    // Silence a noisy warning from better-sqlite3 when imports are traced
    // but the native binding isn't loaded (we mock DB where needed).
    server: { deps: { inline: [/better-sqlite3/] } },
  },
});
