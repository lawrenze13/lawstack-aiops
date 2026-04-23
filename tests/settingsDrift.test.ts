import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same stubs as config.test — drift piggy-backs on getConfig.
vi.mock("server-only", () => ({}));

const rows = new Map<string, string>();

vi.mock("@/server/db/client", () => {
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

vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (_col: unknown, val: string) => ({ __key: val }),
  };
});

vi.mock("@/server/auth/audit", () => ({ audit: vi.fn() }));

// Track the full set of required keys we want to clear from process.env
// so that the "all missing" case is deterministic.
const REQUIRED_KEYS = [
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_URL",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "BASE_REPO",
  "ALLOWED_EMAIL_DOMAINS",
  "WORKTREE_ROOT",
  "DATABASE_URL",
  "PREVIEW_DEV_PATH",
  "PREVIEW_DEV_URL",
];
const envSnapshot: Record<string, string | undefined> = {};

let driftMod: typeof import("@/server/lib/settingsDrift");
let configMod: typeof import("@/server/lib/config");

beforeEach(async () => {
  rows.clear();
  for (const k of REQUIRED_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
  driftMod = await import("@/server/lib/settingsDrift");
  configMod = await import("@/server/lib/config");
});

afterEach(() => {
  for (const k of REQUIRED_KEYS) {
    if (envSnapshot[k] !== undefined) process.env[k] = envSnapshot[k];
    else delete process.env[k];
  }
  configMod.invalidateConfig();
});

describe("detectSettingsDrift", () => {
  it("reports all required fields as missing on fresh install", () => {
    const { hasMissing, missing } = driftMod.detectSettingsDrift();
    expect(hasMissing).toBe(true);
    expect(missing.length).toBeGreaterThan(0);
    // Jira base URL is a required field — must show up.
    expect(missing.some((f) => f.key === "JIRA_BASE_URL")).toBe(true);
  });

  it("drops a field from the missing list when set in DB", () => {
    configMod.__testSetConfigRaw(
      "JIRA_BASE_URL",
      JSON.stringify("https://acme.atlassian.net"),
    );
    const { missing } = driftMod.detectSettingsDrift();
    expect(missing.some((f) => f.key === "JIRA_BASE_URL")).toBe(false);
  });

  it("drops a field from the missing list when set in process.env", () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    configMod.invalidateConfig();
    const { missing } = driftMod.detectSettingsDrift();
    expect(missing.some((f) => f.key === "JIRA_BASE_URL")).toBe(false);
  });

  it("treats empty string as missing (optionalStr coerces empty → undefined)", () => {
    process.env.JIRA_BASE_URL = "";
    configMod.invalidateConfig();
    const { missing } = driftMod.detectSettingsDrift();
    expect(missing.some((f) => f.key === "JIRA_BASE_URL")).toBe(true);
  });

  it("returns hasMissing=false only when every required field is set", () => {
    // Seed every known required key so drift is clean. ALLOWED_EMAIL_DOMAINS
    // is required from the operator too — its zod default is "" (deny-all)
    // specifically so a fresh install surfaces as drift until the wizard
    // collects a real value.
    const seed: Record<string, string> = {
      AUTH_SECRET: "a".repeat(32),
      AUTH_GOOGLE_ID: "goog-id",
      AUTH_GOOGLE_SECRET: "goog-secret",
      AUTH_URL: "https://app.example.com",
      ALLOWED_EMAIL_DOMAINS: "example.com",
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "ops@example.com",
      JIRA_API_TOKEN: "tok",
      BASE_REPO: "/srv/repo",
    };
    for (const [k, v] of Object.entries(seed)) {
      configMod.__testSetConfigRaw(k as never, JSON.stringify(v));
    }
    const result = driftMod.detectSettingsDrift();
    if (result.hasMissing) {
      // Surface what's still missing if this ever flakes.
      throw new Error(
        `expected no drift, still missing: ${result.missing
          .map((f) => f.key)
          .join(", ")}`,
      );
    }
    expect(result.hasMissing).toBe(false);
    expect(result.missing).toEqual([]);
  });
});
