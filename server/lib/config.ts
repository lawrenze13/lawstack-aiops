// Intentionally NOT importing 'server-only' — transitively loaded by the
// migrate CLI via server/db/client.ts → server/lib/env.ts. Next.js still
// tree-shakes this out of client bundles; direct client imports would fail
// on `better-sqlite3` anyway.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Runtime config resolver. Every consumer reads through `getConfig(key)`
// instead of touching `process.env` directly. The setup wizard + admin/
// settings page write via `setConfig`, which invalidates the in-memory
// cache so subsequent reads pick up the new value without a restart.
//
// Precedence (highest wins):
//   1. settings table (DB)   ← set by wizard / /admin/settings
//   2. process.env[key]      ← .env fallback for ops who prefer env vars
//   3. zod schema .default() ← shipped defaults
//
// Cache invariants:
//   - Entries are populated on first read.
//   - setConfig(key, value) deletes the entry for that key; next read
//     repopulates from DB.
//   - Multi-process deployments without a shared cache invalidator would
//     see stale reads for up to the TTL (30s). The orchestrator is a
//     single-process Next.js server, so this is a theoretical concern.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;

type CacheEntry<V> = { value: V; expiresAt: number };
const CACHE = new Map<string, CacheEntry<unknown>>();

/**
 * zod schema for every configurable setting. Kept in this module so
 * config.ts is self-contained — tests can import without pulling env.ts.
 * env.ts re-exports this and wraps it in the Proxy.
 */
const optionalStr = (inner: z.ZodString) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    inner.optional(),
  );

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_SECRET: optionalStr(z.string().min(32)),
  AUTH_GOOGLE_ID: optionalStr(z.string().min(1)),
  AUTH_GOOGLE_SECRET: optionalStr(z.string().min(1)),
  AUTH_URL: optionalStr(z.string().url()),
  ALLOWED_EMAIL_DOMAINS: z.string().min(1).default("multiportal.io"),
  JIRA_START_STATUS: z.string().min(1).default("In Progress"),
  JIRA_REVIEW_STATUS: z.string().min(1).default("Code Review"),
  JIRA_BASE_URL: optionalStr(z.string().url()),
  JIRA_EMAIL: optionalStr(z.string().email()),
  JIRA_API_TOKEN: optionalStr(z.string().min(1)),
  DATABASE_URL: z.string().min(1).default("./data/app.db"),
  WORKTREE_ROOT: z.string().min(1).default("/var/aiops/worktrees"),
  BASE_REPO: optionalStr(z.string().min(1)),
  PREVIEW_DEV_PATH: optionalStr(z.string().min(1)),
  PREVIEW_DEV_URL: optionalStr(z.string().url()),
  // Accept a real boolean from the wizard UI or the string "true"/"1" from
  // a .env fallback. Both normalise to a boolean.
  PREVIEW_DEV_ENABLE_SHELL: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v === "true" || v === "1";
      return false;
    }),
  // Per-agent overrides. JSON-serialised map of
  // { [agentId]: { costWarnUsd?, costKillUsd?, model? } }. Agents' prompts,
  // maxTurns, and permissionMode stay in registry.ts (code-owned).
  AGENT_OVERRIDES: z.string().optional().default("{}"),
});

export type ConfigSchema = z.infer<typeof configSchema>;
export type ConfigKey = keyof ConfigSchema;

// Pre-compute zod defaults once. `parse({})` coerces empty input and
// gives us back whatever the schema defaults resolve to.
const DEFAULTS: Record<string, unknown> = configSchema.parse({});

/**
 * Read a config value. DB row → env var → zod default. Cached for CACHE_TTL_MS
 * (30s) by default. Use {skipCache:true} for tests or critical reads that
 * must see a fresh value.
 */
export function getConfig<K extends ConfigKey>(
  key: K,
  opts: { skipCache?: boolean } = {},
): ConfigSchema[K] {
  if (!opts.skipCache) {
    const hit = CACHE.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value as ConfigSchema[K];
    }
  }

  const value = resolveConfig(key);
  CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function resolveConfig<K extends ConfigKey>(key: K): ConfigSchema[K] {
  // 1. DB settings row.
  try {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    if (row?.value != null && row.value !== "") {
      const parsed = safeParseStoredValue(key, row.value);
      if (parsed !== undefined) return parsed;
    }
  } catch {
    // DB not ready (e.g. pre-migration). Fall through to env.
  }

  // 2. process.env.
  const envVal = process.env[key];
  if (envVal != null && envVal !== "") {
    const parsed = safeParseEnvValue(key, envVal);
    if (parsed !== undefined) return parsed;
  }

  // 3. Zod default.
  return DEFAULTS[key] as ConfigSchema[K];
}

function safeParseStoredValue<K extends ConfigKey>(
  key: K,
  raw: string,
): ConfigSchema[K] | undefined {
  try {
    const json = JSON.parse(raw);
    const fieldSchema = configSchema.shape[key];
    const res = fieldSchema.safeParse(json);
    return res.success ? (res.data as ConfigSchema[K]) : undefined;
  } catch {
    return undefined;
  }
}

function safeParseEnvValue<K extends ConfigKey>(
  key: K,
  raw: string,
): ConfigSchema[K] | undefined {
  const fieldSchema = configSchema.shape[key];
  const res = fieldSchema.safeParse(raw);
  return res.success ? (res.data as ConfigSchema[K]) : undefined;
}

/**
 * Write a config value. Invalidates the cache entry so the next read
 * repopulates from DB.
 */
export function setConfig<K extends ConfigKey>(
  key: K,
  value: ConfigSchema[K],
  actorUserId: string | null,
): void {
  const fieldSchema = configSchema.shape[key];
  const validation = fieldSchema.safeParse(value);
  if (!validation.success) {
    throw new Error(
      `config validation failed for ${key}: ${validation.error.message}`,
    );
  }
  const serialised = JSON.stringify(validation.data);
  db.insert(settings)
    .values({ key, value: serialised, updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: serialised,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      },
    })
    .run();

  CACHE.delete(key);

  audit({
    action: "settings.updated",
    actorUserId,
    payload: { key },
  });
}

/**
 * Drop any cached value for `key`. Used when an external process writes
 * a settings row (rare) or after bulk migrations.
 */
export function invalidateConfig(key?: ConfigKey): void {
  if (key) CACHE.delete(key);
  else CACHE.clear();
}

/**
 * Test-only: directly insert a DB row without running the validator or
 * touching the audit log. Used from vitest to seed settings table state.
 */
export function __testSetConfigRaw<K extends ConfigKey>(
  key: K,
  rawJsonValue: string,
): void {
  db.insert(settings)
    .values({ key, value: rawJsonValue })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: rawJsonValue, updatedAt: new Date() },
    })
    .run();
  CACHE.delete(key);
}
