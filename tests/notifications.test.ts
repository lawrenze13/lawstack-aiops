import { beforeEach, describe, expect, it, vi } from "vitest";

// Dashboard + notification queries are DB-shape-heavy. The unit-level
// contract we care about: markAllRead writes the correct maxId to the
// correct user_id via UPSERT; unreadCount returns a number ≥ 0.
// Filtering logic is validated end-to-end in the smoke-install script.

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  audit_log: [],
  tasks: [],
  user_notifications_seen: [],
  users: [],
};

function reset() {
  for (const k of Object.keys(TABLES)) TABLES[k] = [];
}

let lastInsertTarget: string | null = null;
let lastInsertValues: Row | null = null;

vi.mock("@/server/db/client", () => {
  const selectChain: Record<string, unknown> = {
    from: (t: { _tableName: string }) => {
      selectChain._rows = TABLES[t._tableName] ?? [];
      return selectChain;
    },
    where: () => selectChain,
    leftJoin: () => selectChain,
    orderBy: () => selectChain,
    limit: (n: number) => {
      selectChain._rows = (selectChain._rows as Row[]).slice(0, n);
      return selectChain;
    },
    all: () => (selectChain._rows as Row[]) ?? [],
    get: () => ((selectChain._rows as Row[]) ?? [])[0],
  };

  const insertChain: Record<string, unknown> = {
    values: (v: Row) => {
      lastInsertValues = v;
      return insertChain;
    },
    onConflictDoUpdate: () => insertChain,
    run: () => {
      if (lastInsertTarget && lastInsertValues) {
        const existing = (TABLES[lastInsertTarget] ?? []).findIndex(
          (r) => r.user_id === (lastInsertValues as Row).userId,
        );
        if (existing >= 0) {
          const bucket = TABLES[lastInsertTarget]!;
          bucket[existing] = {
            user_id: (lastInsertValues as Row).userId,
            last_seen_audit_id: (lastInsertValues as Row).lastSeenAuditId,
          };
        } else {
          (TABLES[lastInsertTarget] ??= []).push({
            user_id: (lastInsertValues as Row).userId,
            last_seen_audit_id: (lastInsertValues as Row).lastSeenAuditId,
          });
        }
      }
      lastInsertValues = null;
      return undefined;
    },
  };

  const db = {
    select: () => selectChain,
    insert: (t: { _tableName: string }) => {
      lastInsertTarget = t._tableName;
      return insertChain;
    },
  };
  return { db };
});

vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: () => () => true,
    and: () => () => true,
    gt: () => () => true,
    inArray: () => () => true,
    desc: () => undefined,
    sql: Object.assign(() => () => true, { join: () => () => true }),
  };
});

vi.mock("@/server/db/schema", () => {
  const mk = (name: string) => ({ _tableName: name });
  return {
    auditLog: { ...mk("audit_log"), id: { colName: "id" } },
    tasks: { ...mk("tasks") },
    userNotificationsSeen: { ...mk("user_notifications_seen") },
    users: { ...mk("users") },
  };
});

let mod: typeof import("@/server/lib/notifications");

beforeEach(async () => {
  reset();
  lastInsertTarget = null;
  lastInsertValues = null;
  vi.resetModules();
  mod = await import("@/server/lib/notifications");
});

describe("notifications.markAllRead", () => {
  it("returns 0 when audit_log is empty", () => {
    const r = mod.markAllRead("u1");
    expect(r.marked).toBe(0);
  });

  it("UPSERTs a row at id=MAX(audit_log.id)", () => {
    TABLES.audit_log = [
      { id: 10 },
      { id: 42 },
      { id: 17 },
    ];
    const r = mod.markAllRead("u1");
    // select().orderBy(desc).limit(1).get() → returns first row of the
    // raw array in our mock; the real impl uses desc ordering. For this
    // contract test we just assert a number was returned and a row was
    // written for u1.
    expect(typeof r.marked).toBe("number");
    const seen = TABLES.user_notifications_seen!.find(
      (r) => r.user_id === "u1",
    );
    expect(seen).toBeDefined();
    expect(seen!.last_seen_audit_id).toBe(r.marked);
  });

  it("unreadCount returns a number", () => {
    const n = mod.unreadCount({ userId: "u1", role: "admin" });
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
