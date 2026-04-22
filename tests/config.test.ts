import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Tests for the DB → env → default precedence chain in server/lib/config.ts.
// Stubs the DB + `server-only` + audit so we can unit-test the resolver in
// isolation. The real SSR guard in `server-only` throws outside a Next.js
// server runtime, so we nop it.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

// Capture the config module between tests so the CACHE map resets.
let configMod: typeof import("@/server/lib/config");

// Minimal in-memory DB stand-in: a plain Map of key→row. This mirrors
// the subset of drizzle's API the config module uses.
const rows = new Map<string, string>();

vi.mock("@/server/db/client", () => {
  const get = () => ({
    value: (() => {
      // The test sets `this.__key` via chained call captures below.
      // Each chain returns a stateful proxy so the .get() callsite
      // reads the right key.
      return undefined;
    })(),
  });
  // drizzle exposes select().from().where().get() — we shim via a
  // fluent object whose `where` captures the eq() condition.
  let pendingKey: string | null = null;
  const chain = {
    from: () => chain,
    where: (cond: { __key?: string }) => {
      pendingKey = cond.__key ?? null;
      return chain;
    },
    get: () => {
      if (pendingKey && rows.has(pendingKey)) {
        const v = rows.get(pendingKey)!;
        pendingKey = null;
        return { value: v };
      }
      pendingKey = null;
      return undefined;
    },
    run: () => undefined,
    onConflictDoUpdate: () => chain,
    values: (v: { key: string; value: string }) => {
      rows.set(v.key, v.value);
      return chain;
    },
  };
  const db = {
    select: () => chain,
    insert: () => chain,
  };
  return { db, sqlite: {} };
});

// Replace `eq` so where() captures the key being compared.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>(
    "drizzle-orm",
  );
  return {
    ...actual,
    eq: (col: unknown, val: string) => ({ __key: val }),
  };
});

// audit() is called inside setConfig; stub it so we don't need the auth stack.
vi.mock("@/server/auth/audit", () => ({
  audit: vi.fn(),
}));

const envSnapshot: Record<string, string | undefined> = {};
const envKeysToReset = [
  "JIRA_BASE_URL",
  "JIRA_START_STATUS",
  "ALLOWED_EMAIL_DOMAINS",
  "PREVIEW_DEV_ENABLE_SHELL",
];

beforeEach(async () => {
  rows.clear();
  for (const k of envKeysToReset) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
  configMod = await import("@/server/lib/config");
});

afterEach(() => {
  for (const k of envKeysToReset) {
    if (envSnapshot[k] !== undefined) process.env[k] = envSnapshot[k];
    else delete process.env[k];
  }
  configMod.invalidateConfig();
});

describe("getConfig precedence", () => {
  it("returns zod default when no DB row and no env", () => {
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("In Progress");
    expect(configMod.getConfig("ALLOWED_EMAIL_DOMAINS")).toBe("multiportal.io");
  });

  it("returns process.env value when no DB row", () => {
    process.env.JIRA_START_STATUS = "Ready for Dev";
    configMod.invalidateConfig();
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("Ready for Dev");
  });

  it("returns DB row over process.env", () => {
    process.env.JIRA_START_STATUS = "From Env";
    configMod.__testSetConfigRaw("JIRA_START_STATUS", JSON.stringify("From DB"));
    expect(configMod.getConfig("JIRA_START_STATUS", { skipCache: true })).toBe(
      "From DB",
    );
  });

  it("falls back to env when DB value is invalid JSON", () => {
    process.env.JIRA_START_STATUS = "From Env";
    configMod.__testSetConfigRaw("JIRA_START_STATUS", "{not valid");
    expect(configMod.getConfig("JIRA_START_STATUS", { skipCache: true })).toBe(
      "From Env",
    );
  });

  it("falls back to default when DB + env both fail validation", () => {
    process.env.JIRA_BASE_URL = "not a url";
    configMod.__testSetConfigRaw("JIRA_BASE_URL", JSON.stringify("also not a url"));
    // JIRA_BASE_URL is optional; schema default is undefined.
    expect(configMod.getConfig("JIRA_BASE_URL", { skipCache: true })).toBeUndefined();
  });

  it("handles the PREVIEW_DEV_ENABLE_SHELL string-to-boolean transform", () => {
    process.env.PREVIEW_DEV_ENABLE_SHELL = "true";
    configMod.invalidateConfig();
    expect(configMod.getConfig("PREVIEW_DEV_ENABLE_SHELL")).toBe(true);

    process.env.PREVIEW_DEV_ENABLE_SHELL = "";
    configMod.invalidateConfig();
    expect(configMod.getConfig("PREVIEW_DEV_ENABLE_SHELL")).toBe(false);
  });
});

describe("setConfig + cache invalidation", () => {
  it("writes to DB and next read returns the new value", () => {
    configMod.setConfig("JIRA_START_STATUS", "Fresh", null);
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("Fresh");
  });

  it("invalidates the cache entry so a second read hits fresh state", () => {
    configMod.setConfig("JIRA_START_STATUS", "First", null);
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("First");
    configMod.setConfig("JIRA_START_STATUS", "Second", null);
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("Second");
  });

  it("throws on invalid value (schema validation)", () => {
    // AUTH_SECRET requires min-32-char string when present.
    expect(() =>
      configMod.setConfig("AUTH_SECRET", "too-short", null),
    ).toThrow(/validation failed/i);
  });

  it("cache hits are served without a DB read within TTL", () => {
    configMod.setConfig("JIRA_START_STATUS", "CacheTest", null);
    const first = configMod.getConfig("JIRA_START_STATUS");
    // Delete the underlying row directly — only the cache should matter.
    rows.delete("JIRA_START_STATUS");
    const second = configMod.getConfig("JIRA_START_STATUS");
    expect(second).toBe(first);
    // skipCache=true bypasses and sees the missing row → falls back to default.
    expect(
      configMod.getConfig("JIRA_START_STATUS", { skipCache: true }),
    ).toBe("In Progress");
  });
});

describe("invalidateConfig", () => {
  it("clears a specific key", () => {
    configMod.setConfig("JIRA_START_STATUS", "X", null);
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("X");
    rows.delete("JIRA_START_STATUS");
    configMod.invalidateConfig("JIRA_START_STATUS");
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("In Progress");
  });

  it("clears all keys when called without a key", () => {
    configMod.setConfig("JIRA_START_STATUS", "X", null);
    configMod.setConfig("JIRA_REVIEW_STATUS", "Y", null);
    rows.clear();
    configMod.invalidateConfig();
    expect(configMod.getConfig("JIRA_START_STATUS")).toBe("In Progress");
    expect(configMod.getConfig("JIRA_REVIEW_STATUS")).toBe("Code Review");
  });
});
