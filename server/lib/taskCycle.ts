// Multi-cycle support — generic helpers for "what cycle is this task on?"
//
// A "cycle" is bounded by a non-superseded brainstorm run-start at the head
// and the next `task.implementation_complete` audit row at the tail. Cycle
// 1 is the first time a task goes brainstorm → … → done. Cycle N>1 starts
// when a fresh brainstorm run is spawned after the prior cycle reached done
// (whether by manual re-run or — once shipped — by the QA-fix flow).
//
// Why audit-log-derived state vs. denormalised columns on `tasks`:
//   - No new schema or migration on day 1.
//   - Cycle starts/ends are already audit events — they're the source of
//     truth, just not surfaced.
//   - The composite index `audit_log_task_action_idx` (migration 0003)
//     keeps lookups O(audit-rows-for-this-task), not O(audit-rows-overall).
//   - When a denormalised column is needed (perf cliff at 10k+ tasks),
//     the helper signature stays the same and the implementation swaps —
//     consumers don't change.
//
// Lift path for the QA-fix loop: that feature adds two more helpers in
// this same module (`wasQaFixCycleRun`, `isTaskInQaFixCycle`) reading the
// `qaFixCycle` flag from the same `run.started_request` audit row. The
// generic cycle counting here works for ANY cycle trigger.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditLog, runs, tasks } from "@/server/db/schema";

/**
 * Lane(s) whose start signals "a new cycle has begun." Today: brainstorm
 * is the only such lane (the cascade runs brainstorm → plan → review →
 * implement, and a fresh brainstorm marks the start of a new pass). The
 * customizable-workflow branch may eventually let operators rename or
 * reorder lanes — when that lands, swap this constant for a query against
 * a `lanes.role = 'cycle_start'` flag. Until then, the constant is the
 * single point of compatibility.
 */
const CYCLE_START_LANES = ["brainstorm"] as const;

export type CycleContext = {
  /** Number of non-superseded brainstorm runs on the task. 0 = the task
   *  hasn't started its first cycle yet (lane is still ticket/branch). */
  count: number;
  /** Same value as `count`, named for read sites that want the human
   *  number ("cycle 2"). Cycle 1 = first time through; cycle 2 = first
   *  re-run; etc. */
  number: number;
  /** Start time of the current cycle. The most recent non-superseded
   *  brainstorm run's `started_at`, or `task.createdAt` when no
   *  brainstorm has run yet. Used to scope UI predicates that should
   *  only consider runs/audit-rows from the current cycle. */
  startedAt: Date;
};

/**
 * Single round-trip cycle context — one query reads count + most-recent
 * started_at. Falls back to `task.createdAt` when there are no brainstorm
 * runs yet (the task is fresh, lane=ticket or branch). Returns
 * `{count: 0, number: 0, startedAt: <task.createdAt>}` rather than
 * throwing on tasks that don't exist — caller responsibility to validate.
 */
export function getCycleContext(taskId: string): CycleContext {
  // Pull both aggregates in one query so the index hit costs once.
  // `supersededAt IS NULL` filter is load-bearing: a manually re-run
  // brainstorm sets supersededAt on the prior row; without the filter
  // the count would inflate from 2 to 3 on cycle 2 and break predicates
  // that gate post-review buttons. (Deepen-plan finding: data-integrity
  // SEV-2.)
  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      latestStartedAtMs: sql<number | null>`MAX(${runs.startedAt})`,
    })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        // Lane filter via CYCLE_START_LANES — see constant header for the
        // customizable-workflow lift path.
        inArray(runs.lane, [...CYCLE_START_LANES]),
        isNull(runs.supersededAt),
      ),
    )
    .get();

  const count = row?.count ?? 0;
  if (count === 0 || row?.latestStartedAtMs == null) {
    // No brainstorm yet — fall back to task creation time so cycle-scoped
    // predicates have a sensible epoch to filter against.
    const task = db
      .select({ createdAt: tasks.createdAt })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    return {
      count: 0,
      number: 0,
      startedAt: task?.createdAt ?? new Date(0),
    };
  }

  return {
    count,
    number: count,
    startedAt: new Date(row.latestStartedAtMs),
  };
}

/**
 * Backwards-compat thin wrappers. Callers that only need one value can
 * reach for these to keep call sites readable. Internally they share the
 * same `getCycleContext` query — keep one source of truth for the math.
 */
export function taskCycleCount(taskId: string): number {
  return getCycleContext(taskId).count;
}

export function currentCycleNumber(taskId: string): number {
  return getCycleContext(taskId).number;
}

export function currentCycleStartedAt(taskId: string): Date {
  return getCycleContext(taskId).startedAt;
}

/**
 * True iff the brainstorm run identified by runId was started as the
 * head of a QA fix cycle (operator clicked Fix from QA). Mirrors the
 * shape of `wasAmendmentRun` in server/jira/amendComment.ts.
 *
 * Reads the run's `run.started_request` audit row's payload — the
 * `qaFixCycle: true` flag is set by the qa-fix/start endpoint when it
 * forwards into startRun.
 */
export function wasQaFixCycleRun(runId: string): boolean {
  const row = db
    .select({ payloadJson: auditLog.payloadJson })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.runId, runId),
        eq(auditLog.action, "run.started_request"),
      ),
    )
    .limit(1)
    .get();
  if (!row?.payloadJson) return false;
  try {
    const payload = JSON.parse(row.payloadJson) as { qaFixCycle?: boolean };
    return payload.qaFixCycle === true;
  } catch {
    return false;
  }
}

/**
 * True iff the task is currently mid-QA-fix-cycle: there's been a
 * brainstorm run-start with `qaFixCycle: true` since the most recent
 * `task.implementation_complete` audit row (or since task creation if
 * the task has never reached done — that case is a no-op in practice
 * because the QA-fix button only fires from the `done` lane).
 *
 * Used by `implementComplete` to swap the implementation-pushed Jira
 * comment for the QA-fix-pushed one, and by the UI to render the
 * QA-fix-specific chip text.
 */
export function isTaskInQaFixCycle(taskId: string): boolean {
  // Find the most recent run.started_request with qaFixCycle=true for
  // this task. If it exists AND no task.implementation_complete row
  // has fired since, the cycle is open.
  const qaStart = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, "run.started_request"),
        sql`json_extract(${auditLog.payloadJson}, '$.qaFixCycle') = 1`,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  if (!qaStart) return false;

  const closeAfter = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, "task.implementation_complete"),
        sql`${auditLog.id} > ${qaStart.id}`,
      ),
    )
    .limit(1)
    .get();

  return !closeAfter;
}

/**
 * Number of QA fix cycles that have been started for this task.
 * 0 = never; 1 = one QA cycle started (regardless of whether closed).
 * Drives the `QA fix · N` chip on the card header.
 */
export function qaFixCycleCount(taskId: string): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, "run.started_request"),
        sql`json_extract(${auditLog.payloadJson}, '$.qaFixCycle') = 1`,
      ),
    )
    .get();
  return row?.count ?? 0;
}

/**
 * ISO timestamp of the most recent `task.implementation_complete` audit
 * row for the task, or null if the task has never reached `done`. Used by
 * the QA-fix loop's comments-since-done picker (extracted into this
 * generic module so the multi-cycle support PR ships the substrate; the
 * QA-fix PR just consumes it).
 */
export function lastImplementationCompleteAt(taskId: string): Date | null {
  const row = db
    .select({ ts: auditLog.ts })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.taskId, taskId),
        eq(auditLog.action, "task.implementation_complete"),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  return row?.ts ?? null;
}
