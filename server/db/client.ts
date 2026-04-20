// Intentionally NOT importing 'server-only' here — this module is also
// imported by the standalone migrate CLI (tsx server/db/migrate-cli.ts).
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { env } from "@/server/lib/env";
import * as schema from "./schema";

// HMR-safe singleton. Without this, dev hot-reloads would create a new
// Database handle per route invocation and leak file descriptors.
declare global {
  // eslint-disable-next-line no-var
  var __sqlite: Database.Database | undefined;
}

function openDatabase(): Database.Database {
  const dbPath = path.isAbsolute(env.DATABASE_URL)
    ? env.DATABASE_URL
    : path.join(process.cwd(), env.DATABASE_URL);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // Pragmas chosen for write-heavy logging on a single host.
  // See research item #4 in the plan for rationale.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 268435456");
  return db;
}

export const sqlite = globalThis.__sqlite ?? openDatabase();
if (env.NODE_ENV !== "production") {
  globalThis.__sqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

// Run boot reconciler exactly once on first DB import in any server context.
// Lives here (not instrumentation.ts) because the latter is webpack-bundled
// for both Node and Edge runtimes and chokes on better-sqlite3's bindings.
import("../worker/lazy-init").then((m) => m.ensureInitialised()).catch(() => {});
