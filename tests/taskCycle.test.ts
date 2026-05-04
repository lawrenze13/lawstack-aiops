// Real-SQLite test for the cycle helpers — applies migrations to an
// in-memory better-sqlite3 DB, seeds fixtures, asserts behaviour. Existing
// tests in this repo mock the DB layer; this file uses a real DB instead
// because the helpers' value is in their query semantics (filter,
// aggregate, fallback) and a mock would let drift go uncaught.

import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Build a single in-memory DB, run migrations once. Tests reset table
// contents in beforeEach (faster than re-running migrations).
const sqlite = new Database(":memory:");
const testDb = drizzle(sqlite);
migrate(testDb, {
  migrationsFolder: path.join(process.cwd(), "server/db/migrations"),
});

vi.mock("@/server/db/client", () => ({
  db: testDb,
  sqlite,
}));

// Lazy import after the mock takes effect.
let taskCycle: typeof import("@/server/lib/taskCycle");
let schema: typeof import("@/server/db/schema");

beforeEach(async () => {
  // Order matters because of FK constraints. Disable FKs briefly for
  // wholesale truncation (alternative: delete in dependency order).
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(`
    DELETE FROM audit_log;
    DELETE FROM artifacts;
    DELETE FROM messages;
    DELETE FROM runs;
    DELETE FROM pr_records;
    DELETE FROM worktrees;
    DELETE FROM tasks;
    DELETE FROM users;
  `);
  sqlite.pragma("foreign_keys = ON");

  vi.resetModules();
  taskCycle = await import("@/server/lib/taskCycle");
  schema = await import("@/server/db/schema");

  // Seed one user + one task so cycle helpers have something to read.
  testDb
    .insert(schema.users)
    .values({
      id: "u1",
      email: "u1@example.com",
      name: "User 1",
      role: "admin",
    })
    .run();
  testDb
    .insert(schema.tasks)
    .values({
      id: "task-1",
      jiraKey: "TEST-1",
      title: "test task",
      ownerId: "u1",
      status: "active",
      currentLane: "ticket",
      createdAt: new Date(1_000_000_000_000), // fixed for deterministic asserts
      updatedAt: new Date(1_000_000_000_000),
    })
    .run();
});

// ─── Helpers to seed cycle-relevant fixtures ─────────────────────────────

function insertBrainstormRun(opts: {
  id: string;
  startedAtMs: number;
  supersededAtMs?: number;
}) {
  testDb
    .insert(schema.runs)
    .values({
      id: opts.id,
      taskId: "task-1",
      lane: "brainstorm",
      agentId: "ce:brainstorm",
      agentConfigSnapshotJson: "{}",
      claudeSessionId: `session-${opts.id}`,
      status: "completed",
      startedAt: new Date(opts.startedAtMs),
      finishedAt: new Date(opts.startedAtMs + 1000),
      supersededAt: opts.supersededAtMs != null ? new Date(opts.supersededAtMs) : null,
    })
    .run();
}

function insertImplementationCompleteAudit(tsMs: number) {
  testDb
    .insert(schema.auditLog)
    .values({
      ts: new Date(tsMs),
      action: "task.implementation_complete",
      taskId: "task-1",
      runId: null,
      payloadJson: "{}",
    })
    .run();
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("taskCycle.getCycleContext", () => {
  it("returns count=0 + task.createdAt when no brainstorm has run", () => {
    const ctx = taskCycle.getCycleContext("task-1");
    expect(ctx.count).toBe(0);
    expect(ctx.number).toBe(0);
    expect(ctx.startedAt.getTime()).toBe(1_000_000_000_000);
  });

  it("returns count=1 + that brainstorm's started_at after one run", () => {
    insertBrainstormRun({ id: "run-b1", startedAtMs: 2_000_000_000_000 });
    const ctx = taskCycle.getCycleContext("task-1");
    expect(ctx.count).toBe(1);
    expect(ctx.number).toBe(1);
    expect(ctx.startedAt.getTime()).toBe(2_000_000_000_000);
  });

  it("returns count=2 + most-recent started_at after two non-superseded brainstorms", () => {
    insertBrainstormRun({ id: "run-b1", startedAtMs: 2_000_000_000_000 });
    insertBrainstormRun({ id: "run-b2", startedAtMs: 3_000_000_000_000 });
    const ctx = taskCycle.getCycleContext("task-1");
    expect(ctx.count).toBe(2);
    expect(ctx.startedAt.getTime()).toBe(3_000_000_000_000);
  });

  it("ignores superseded brainstorm runs (data-integrity SEV-2 fix)", () => {
    // Operator started cycle 2 brainstorm, then re-ran it manually —
    // first cycle-2 brainstorm gets supersededAt set; only the second
    // counts as the active cycle-2 head.
    insertBrainstormRun({ id: "run-b1", startedAtMs: 2_000_000_000_000 });
    insertBrainstormRun({
      id: "run-b2-superseded",
      startedAtMs: 3_000_000_000_000,
      supersededAtMs: 3_500_000_000_000,
    });
    insertBrainstormRun({ id: "run-b2-fresh", startedAtMs: 4_000_000_000_000 });

    const ctx = taskCycle.getCycleContext("task-1");
    // 3 inserts, 1 superseded → count=2 (cycle 1 head + cycle 2 head).
    expect(ctx.count).toBe(2);
    // startedAt is the most recent NON-superseded brainstorm.
    expect(ctx.startedAt.getTime()).toBe(4_000_000_000_000);
  });

  it("falls back to task.createdAt when ALL brainstorms are superseded", () => {
    insertBrainstormRun({
      id: "run-b1",
      startedAtMs: 2_000_000_000_000,
      supersededAtMs: 2_500_000_000_000,
    });
    const ctx = taskCycle.getCycleContext("task-1");
    expect(ctx.count).toBe(0);
    expect(ctx.startedAt.getTime()).toBe(1_000_000_000_000);
  });
});

describe("taskCycle thin wrappers", () => {
  it("taskCycleCount + currentCycleNumber agree with getCycleContext.count", () => {
    insertBrainstormRun({ id: "run-b1", startedAtMs: 2_000_000_000_000 });
    insertBrainstormRun({ id: "run-b2", startedAtMs: 3_000_000_000_000 });
    expect(taskCycle.taskCycleCount("task-1")).toBe(2);
    expect(taskCycle.currentCycleNumber("task-1")).toBe(2);
  });

  it("currentCycleStartedAt agrees with getCycleContext.startedAt", () => {
    insertBrainstormRun({ id: "run-b1", startedAtMs: 2_000_000_000_000 });
    expect(taskCycle.currentCycleStartedAt("task-1").getTime()).toBe(
      2_000_000_000_000,
    );
  });
});

describe("taskCycle.lastImplementationCompleteAt", () => {
  it("returns null when the task has never reached done", () => {
    expect(taskCycle.lastImplementationCompleteAt("task-1")).toBeNull();
  });

  it("returns the most recent matching audit row's ts", () => {
    insertImplementationCompleteAudit(2_500_000_000_000);
    insertImplementationCompleteAudit(3_500_000_000_000);
    insertImplementationCompleteAudit(4_500_000_000_000);
    expect(
      taskCycle.lastImplementationCompleteAt("task-1")?.getTime(),
    ).toBe(4_500_000_000_000);
  });

  it("scopes to the requested task", () => {
    // Add another task + its implementation_complete row; assert ours
    // doesn't pick it up.
    testDb
      .insert(schema.tasks)
      .values({
        id: "task-2",
        jiraKey: "TEST-2",
        title: "other task",
        ownerId: "u1",
        status: "active",
        currentLane: "done",
      })
      .run();
    testDb
      .insert(schema.auditLog)
      .values({
        ts: new Date(9_999_999_999_999),
        action: "task.implementation_complete",
        taskId: "task-2",
        runId: null,
        payloadJson: "{}",
      })
      .run();
    expect(taskCycle.lastImplementationCompleteAt("task-1")).toBeNull();
  });
});
