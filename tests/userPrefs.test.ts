import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ─── In-memory fake DB, focused on user_prefs UPSERT semantics ──────────────
const STORE = new Map<string, { agentOverridesJson: string; notificationsJson: string }>();

vi.mock("@/server/db/client", () => {
  let pendingKey: string | null = null;
  let pendingValues: { userId: string; agentOverridesJson: string; notificationsJson: string } | null = null;
  let mode: "select" | "insert" | null = null;

  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (cond: { __key?: string }) => {
      pendingKey = cond.__key ?? null;
      return chain;
    },
    get: () => {
      mode = "select";
      if (!pendingKey) return undefined;
      const row = STORE.get(pendingKey);
      pendingKey = null;
      return row;
    },
    run: () => {
      if (mode === "insert" && pendingValues) {
        STORE.set(pendingValues.userId, {
          agentOverridesJson: pendingValues.agentOverridesJson,
          notificationsJson: pendingValues.notificationsJson,
        });
      }
      pendingValues = null;
      mode = null;
      return undefined;
    },
    values: (v: {
      userId: string;
      agentOverridesJson: string;
      notificationsJson: string;
    }) => {
      mode = "insert";
      pendingValues = v;
      return chain;
    },
    onConflictDoUpdate: (opts: {
      set: { agentOverridesJson: string; notificationsJson: string };
    }) => {
      if (pendingValues) {
        pendingValues = {
          userId: pendingValues.userId,
          agentOverridesJson: opts.set.agentOverridesJson,
          notificationsJson: opts.set.notificationsJson,
        };
      }
      return chain;
    },
  };

  return {
    db: {
      select: () => chain,
      insert: () => chain,
    },
  };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return { ...actual, eq: (_col: unknown, val: string) => ({ __key: val }) };
});

vi.mock("@/server/db/schema", () => ({
  userPrefs: { userId: "user_id" },
}));

let mod: typeof import("@/server/lib/userPrefs");

beforeEach(async () => {
  STORE.clear();
  vi.resetModules();
  mod = await import("@/server/lib/userPrefs");
});

describe("userPrefs read/write", () => {
  it("returns DEFAULTS when no row exists", () => {
    const r = mod.readUserPrefs("u1");
    expect(r).toEqual({ agentOverrides: {}, notifications: {} });
  });

  it("persists overrides via writeUserPrefs + reads back", () => {
    mod.writeUserPrefs("u1", {
      agentOverrides: { "ce:work": { costWarnUsd: 5, model: "claude-haiku-4-5-20251001" } },
    });
    const r = mod.readUserPrefs("u1");
    expect(r.agentOverrides["ce:work"]).toEqual({
      costWarnUsd: 5,
      model: "claude-haiku-4-5-20251001",
    });
    expect(r.notifications).toEqual({});
  });

  it("merges patches — writing notifications preserves agent overrides", () => {
    mod.writeUserPrefs("u1", {
      agentOverrides: { "ce:work": { costKillUsd: 20 } },
    });
    mod.writeUserPrefs("u1", {
      notifications: { onComplete: true },
    });
    const r = mod.readUserPrefs("u1");
    expect(r.agentOverrides["ce:work"]).toEqual({ costKillUsd: 20 });
    expect(r.notifications).toEqual({ onComplete: true });
  });

  it("rejects malformed JSON and falls back to defaults", () => {
    STORE.set("u1", {
      agentOverridesJson: "{not json",
      notificationsJson: "{}",
    });
    const r = mod.readUserPrefs("u1");
    expect(r.agentOverrides).toEqual({});
  });

  it("rejects invalid schema shape and falls back to defaults", () => {
    STORE.set("u1", {
      agentOverridesJson: JSON.stringify({ "ce:work": { costWarnUsd: "not a number" } }),
      notificationsJson: "{}",
    });
    const r = mod.readUserPrefs("u1");
    expect(r.agentOverrides).toEqual({});
  });
});
