// Intentionally NOT importing 'server-only' — this module is also called
// from the standalone migrate CLI.
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client";

let migrated = false;

// Run drizzle migrations once per process. Safe to call from instrumentation
// (boot) and from the migrate-cli script.
export function runMigrations(): void {
  if (migrated) return;
  migrate(db, { migrationsFolder: path.join(process.cwd(), "server/db/migrations") });
  migrated = true;
}
