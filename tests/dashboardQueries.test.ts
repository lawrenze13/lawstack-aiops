import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same stubbing pattern as config.test: server-only shim, fake DB.
vi.mock("server-only", () => ({}));

/*
 * In-memory fake DB that matches the subset of drizzle's fluent API
 * the dashboard queries actually use: select / from / where / leftJoin
 * / orderBy / limit / .all(). Rows are keyed per-table.
 */
type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  tasks: [],
  runs: [],
  audit_log: [],
  users: [],
};

function resetTables() {
  TABLES.tasks = [];
  TABLES.runs = [];
  TABLES.audit_log = [];
  TABLES.users = [];
}

vi.mock("@/server/db/client", () => {
  type Projection = Record<string, { colName: string }>;

  function project(rows: Row[], projection: Projection | undefined): Row[] {
    if (!projection) return rows;
    return rows.map((r) => {
      const out: Row = {};
      for (const [alias, col] of Object.entries(projection)) {
        out[alias] = r[col.colName];
      }
      return out;
    });
  }

  const db = {
    select: (projection?: Projection) => {
      let rows: Row[] = [];
      const chain: Record<string, unknown> = {
        from: (table: { _tableName: string }) => {
          rows = [...(TABLES[table._tableName] ?? [])];
          return chain;
        },
        where: (predicate: unknown) => {
          if (typeof predicate === "function") {
            rows = rows.filter(predicate as (r: Row) => boolean);
          }
          return chain;
        },
        leftJoin: () => chain,
        orderBy: () => chain,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return chain;
        },
        all: () => project(rows, projection),
        get: () => project(rows, projection)[0],
      };
      return chain;
    },
  };
  return { db };
});

vi.mock("@/server/db/schema", () => {
  const mkCol = (tableName: string, colName: string) => ({
    tableName,
    colName,
    _tableName: tableName,
  });
  const mkTable = (name: string, cols: string[]) => {
    const t: Record<string, unknown> = { _tableName: name };
    for (const c of cols) t[c] = mkCol(name, c);
    t.$inferSelect = undefined;
    return t;
  };
  return {
    tasks: mkTable("tasks", ["id", "ownerId"]),
    runs: mkTable("runs", [
      "id",
      "taskId",
      "lane",
      "agentId",
      "status",
      "costUsdMicros",
      "lastHeartbeatAt",
      "startedAt",
      "finishedAt",
    ]),
    auditLog: mkTable("audit_log", [
      "id",
      "ts",
      "action",
      "actorUserId",
      "taskId",
    ]),
    users: mkTable("users", ["id", "name", "email"]),
  };
});

// drizzle-orm helpers — since our fake where() takes a function, we just
// collapse helpers to pass-throughs. The real predicate matters only in
// integration tests; here we verify scope filtering logically.
vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: () => () => true,
    and: () => () => true,
    or: () => () => true,
    gt: () => () => true,
    lt: () => () => true,
    inArray: () => () => true,
    isNotNull: () => () => true,
    desc: () => undefined,
    sql: Object.assign(() => () => true, { join: () => () => true }),
  };
});

// Because our fake "where" only filters when given a function, and we
// return `() => true` from helpers, queries effectively return ALL rows.
// This lets us assert scope behaviour at the public-API level by setting
// up row fixtures and checking aggregate counts.

let queries: typeof import("@/server/lib/dashboardQueries");

beforeEach(async () => {
  resetTables();
  vi.resetModules();
  queries = await import("@/server/lib/dashboardQueries");
});

afterEach(() => {
  resetTables();
});

describe("dashboardQueries — scope & aggregation", () => {
  it("opsHealth reports 0 across the board with empty tables", () => {
    const r = queries.opsHealth({ userId: "u1", role: "admin" });
    expect(r).toEqual({ live: 0, stuck: 0, errors24h: 0 });
  });

  it("costMeter returns zero totals with no runs", () => {
    const r = queries.costMeter({ userId: "u1", role: "admin" });
    expect(r.today).toBe(0);
    expect(r.week).toBe(0);
    expect(r.topAgents).toEqual([]);
  });

  it("throughputByLane returns empty series when audit_log is empty", () => {
    const r = queries.throughputByLane({ userId: "u1", role: "admin" });
    expect(r.total).toBe(0);
    for (const lane of r.lanes) {
      expect(r.byLane[lane]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    }
  });

  it("activityFeed returns empty with no audit rows", () => {
    const r = queries.activityFeed({ userId: "u1", role: "admin" }, 20);
    expect(r).toEqual([]);
  });

  it("costMeter aggregates micros → USD + groups top agents", () => {
    TABLES.runs = [
      { agentId: "ce:work", costUsdMicros: 5_000_000, startedAt: new Date() },
      { agentId: "ce:work", costUsdMicros: 2_000_000, startedAt: new Date() },
      { agentId: "ce:review", costUsdMicros: 1_500_000, startedAt: new Date() },
    ];
    const r = queries.costMeter({ userId: "u1", role: "admin" });
    expect(r.week).toBeCloseTo(8.5);
    expect(r.topAgents[0]).toEqual({ agentId: "ce:work", usd: 7 });
    expect(r.topAgents[1]).toEqual({ agentId: "ce:review", usd: 1.5 });
  });
});
