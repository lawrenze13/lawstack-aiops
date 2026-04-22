// Intentionally NOT importing 'server-only' — server/db/client.ts imports
// this module, and client.ts is loaded by the standalone `npm run db:migrate`
// CLI (pure Node, no Next.js server bundle). server-only would throw there.
// The Next.js bundler still tree-shakes server/* out of client bundles.
import {
  configSchema,
  getConfig,
  type ConfigKey,
  type ConfigSchema,
} from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// `env` used to be a static object loaded once at module import. The setup
// wizard + /admin/settings store config in a DB table that can be edited
// at runtime, so we flip env into a Proxy that lazily reads each property
// through `getConfig(key)`. Call sites don't change —
// `env.JIRA_BASE_URL` still works and automatically picks up DB-stored
// values without a restart.
//
// The shape is preserved from the old static version via `configSchema`,
// so TypeScript inference works unchanged at every call site.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEYS = new Set(Object.keys(configSchema.shape));

export const env = new Proxy({} as ConfigSchema, {
  get(_target, prop) {
    if (typeof prop !== "string") return undefined;
    if (!CONFIG_KEYS.has(prop)) return undefined;
    return getConfig(prop as ConfigKey);
  },
  has(_target, prop) {
    return typeof prop === "string" && CONFIG_KEYS.has(prop);
  },
  ownKeys() {
    return Array.from(CONFIG_KEYS);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== "string" || !CONFIG_KEYS.has(prop)) return undefined;
    return {
      enumerable: true,
      configurable: true,
      value: getConfig(prop as ConfigKey),
    };
  },
});

/**
 * Parsed list of allowed email domains, lowercased, trimmed, no empties.
 * Getter so it re-reads on every access (domains are edited from the
 * wizard and /admin/settings; callers expect live data).
 */
export function getAllowedDomains(): readonly string[] {
  return env.ALLOWED_EMAIL_DOMAINS.toLowerCase()
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/**
 * Back-compat export. The old env.ts exposed this as a readonly array
 * computed once at import; we keep the name stable via a Proxy of its
 * own so consumers doing `ALLOWED_DOMAINS.includes(x)` still work.
 */
export const ALLOWED_DOMAINS: readonly string[] = new Proxy([] as string[], {
  get(_target, prop) {
    const fresh = getAllowedDomains();
    return Reflect.get(fresh, prop, fresh);
  },
  has(_target, prop) {
    return Reflect.has(getAllowedDomains(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getAllowedDomains());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getAllowedDomains(), prop);
  },
});
