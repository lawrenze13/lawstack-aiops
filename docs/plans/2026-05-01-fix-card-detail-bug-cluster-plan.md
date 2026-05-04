---
title: Card detail bug cluster — chat coherence, multi-cycle support, log scope, preview dev force-switch
type: fix
status: active
date: 2026-05-01
origin: docs/reviews/2026-05-01-card-detail-bugs-review.md
---

# Card detail bug cluster

## Enhancement Summary

**Deepened on:** 2026-05-01
**Sections enhanced:** 7 (Architecture, Phase 1, Phase 2, Phase 4,
Phase 6, Risk Analysis, Dependencies)
**Agents consulted:** julik-frontend-races-reviewer, kieran-typescript-
reviewer, code-simplicity-reviewer, architecture-strategist,
pattern-recognition-specialist, performance-oracle, security-sentinel,
data-integrity-guardian, framework-docs-researcher (React 19 + Next.js
15), best-practices-researcher (SSE / EventSource).

### Must-fix-before-merge (consensus from multiple agents)

These are surfaced as full subsections under "## Deepen-Plan Research
Findings" below. Reading them is a hard prerequisite for `/ce:work`.

1. **Add a `(task_id, action)` index on `audit_log`** (performance).
   The plan's claim that this index exists is wrong — it doesn't.
   Without it, every card-detail page render does 3 full-table
   audit-log scans. Ship as a one-line migration alongside Phase 2.
2. **Promote the cycle-dedup audit check from Risk #3 to a Phase 4
   acceptance criterion** (data-integrity, security). Without it,
   any partial-failure retry on `approveCycle` posts duplicate Jira
   comments AND can corrupt cycle-counter math.
3. **Read `currentCycleNumber` INSIDE `withRunLock`, not before**
   (data-integrity). The endpoint-level branch creates a real race
   where a concurrent brainstorm start mid-flight runs the wrong
   approval path against stale artifacts.
4. **Cycle helpers must filter `runs.supersededAt IS NULL`**
   (data-integrity). A manually re-run brainstorm during cycle 2
   inflates the count from 2 to 3 and breaks predicates.
5. **Restore `localUnlock` on POST failure in ChatBox** (frontend-
   races). Today's plan-sketch leaves the textarea bricked when
   the server returns 429 or any non-2xx — the exact UX the layer
   is meant to fix.
6. **Fix the `router.refresh()` ordering bug in Phase 1's pseudocode**
   (frontend-races). It currently fires synchronously BEFORE the
   POST resolves — effectively a no-op refresh.
7. **CSRF guard on `/api/tasks/[id]/preview`** when `force:true`
   (security). NextAuth's CSRF protection covers its own endpoints,
   not arbitrary `/api/*`. A destructive endpoint needs an
   Origin/Referer check or a custom header.
8. **`git stash create` before `git checkout -f`** (security). The
   force-switch destroys uncommitted work without a recovery path;
   a dangling stash commit makes 14-day recovery via reflog
   possible.
9. **`key={taskId}` on `<CardThread>`** (security). Forces React to
   remount the component when navigating between cards, preventing
   stale-runId leakage across cards.
10. **Cycle counting must be lane-role-aware, not lane-name-aware**
    (architecture). Hard-keying on `runs.lane === "brainstorm"`
    breaks the moment the customizable-workflow branch lets
    operators rename lanes.

### Should-do-soon (architecture + simplicity, defer-OK)

11. Extract `approveSteps.ts` (`writeArtifactsToWorktree`,
    `commitIfDirty`, `robustPush`, `findExistingPrUrl`) shared by
    `approveAndPr` AND `approveCycle` to prevent permanent drift.
12. Collapse three cycle helpers into one `getCycleContext(taskId)`
    snapshot returning `{ count, startedAt, number }` from a single
    query.
13. Audit action naming: use existing `approve.completed` with
    `payload.cycleNumber`, not new `approve.cycle_completed`. Use
    `preview.switched` with `payload.force: true`, not new
    `preview.force_switched`.
14. Endpoint-internal dispatch instead of route-level branching —
    a single `approveTask(taskId, actorUserId)` that consults
    cycle helpers inside the lock and dispatches to the right
    strategy.
15. Inline `cyclePushedCommentDoc` into `server/jira/adf.ts` next
    to `prCommentDoc` (pattern consistency).
16. Inline `ScopeToggle` into `RunLog.tsx` (single-use).
17. Drop the smoke script + runbook from Phase 7 (integration test
    + manual verification cover the same ground for v1).
18. Use a typed Zod parser for audit-log payloads
    (`AuditPayloads.RunStartedRequest`) instead of inline casts.

### Could-do-later (polish, not blocking)

19. Consolidate the two parallel EventSources (RunLog + ChatBox) via
    a `RunStreamContext` provider when a third subscriber lands.
20. `useSyncExternalStore` for the localStorage scope toggle (more
    idiomatic React 19; `useEffect` works for v1).
21. Confirm HTTP/2 at the edge so the 6-connection-per-origin limit
    doesn't bite when operators open many tabs.

---

## Deepen-Plan Research Findings

### Layer A — frontend race & lifecycle hardening

**Critical bugs in Phase 1's pseudocode that must be fixed before
ship** (julik-frontend-races-reviewer):

```typescript
// components/card-detail/ChatBox.tsx — corrected send()
const inFlightRef = useRef(false);

const send = () => {
  if (inFlightRef.current) return;        // C2: prevent stale-runId double-fire
  const trimmed = text.trim();
  if (!trimmed) return;
  setError(null);

  const wasUnlocked = localUnlock;        // C1: capture before optimistic clear
  setLocalUnlock(false);
  inFlightRef.current = true;

  startTransition(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/message`, { ... });
      if (!res.ok) {
        setLocalUnlock(wasUnlocked);      // C1: restore unlock on failure
        // ...error handling
        return;
      }
      const Body = z.object({ runId: z.string().min(1) });
      const parsed = Body.safeParse(await res.json().catch(() => null));
      setText("");
      if (parsed.success) {
        onRunIdChanged(parsed.data.runId);
      }
      router.refresh();                   // I3: AFTER await, not before
    } finally {
      inFlightRef.current = false;
    }
  });
};
```

**Cancel-token guard for both EventSources** (C3) — both `RunLog.tsx`
and `ChatBox.tsx` need a synchronous cancel token in their SSE
`useEffect` so handlers ignore events from a closure that's about to
unmount but is still queued in the JS event loop:

```typescript
useEffect(() => {
  const ctrl = { cancelled: false };
  const es = new EventSource(`/api/runs/${runId}/stream`);
  const onServer = (e: MessageEvent) => {
    if (ctrl.cancelled) return;          // ignore after rebind
    // ...existing logic
  };
  es.addEventListener("server", onServer);
  return () => {
    ctrl.cancelled = true;
    es.close();
  };
}, [runId]);
```

**`CardThread` must sync down server-pushed runId** (I1):

```typescript
// components/card-detail/CardThread.tsx
export function CardThread({ initialRunId, ...props }) {
  const [runId, setRunId] = useState(initialRunId);
  // Sync down when server-rendered initialRunId changes
  // (auto-advance creating a new run, etc.)
  useEffect(() => { setRunId(initialRunId); }, [initialRunId]);
  return <>...</>;
}
```

Plus the page-level `key={taskId}` on `<CardThread>` to force remount
across card navigation (security M2).

**Reset `needsInputQuestion` and other per-run derived state on runId
change** (C4) — already partially handled by `resetForRun` reducer
action; add `needsInputQuestion: null` reset and verify
`costUsd` resets to `initialCostUsd`.

**React 19 + Next.js 15 specifics** (framework-docs-researcher):

- `router.refresh()` does NOT return a promise. Don't try to await
  it. Wrapping it in `startTransition` is exactly what couples
  `pending` to the round-trip — the bug we're fixing. Outside
  `startTransition` is correct.
- **Don't reach for `useOptimistic`** here. It's designed for
  Action-driven flows where the optimistic state auto-reverts when
  the transition ends. Plain `useState` is the right shape for
  "POST → read response → keep until refresh lands."
- StrictMode double-mounts every effect in dev. The plan's
  `useEffect([runId])` cleanup pattern handles this correctly via
  `es.close()`. Known [Firefox bug 1965626](https://bugzilla.mozilla.org/show_bug.cgi?id=1965626)
  — malformed initial GET when EventSource is closed immediately.
  Test in Chrome; document the Firefox quirk.
- Known [Next.js issue #77504](https://github.com/vercel/next.js/issues/77504)
  — `router.refresh()` can be unreliable on dynamic routes with
  caching. If this bites, the fallback is moving the message POST
  to a Server Action and calling `revalidatePath` server-side.

**SSE patterns to adopt** (best-practices-researcher):

- Two parallel EventSources on the same URL is a code smell but not
  a correctness bug under HTTP/2. Confirm HTTP/2 at the edge
  (Caddy default = yes). Defer consolidation via a
  `RunStreamContext` provider until a third subscriber lands.
- Server stream MUST emit `id: <n>` lines (the existing parser does
  this) so the browser auto-sends `Last-Event-ID` on reconnect.
- Server MUST set `X-Accel-Buffering: no` if any nginx is in front
  of Next.js (n/a today; Caddy doesn't buffer SSE by default).
- Client MUST call `eventSource.close()` on `end` event. Otherwise
  browser auto-reconnects after `retry` ms (default 3000) — already
  done at `RunLog.tsx:316`.

### Layer B — multi-cycle correctness

**Add a DB index migration as a Phase 2 hard prerequisite**
(performance-oracle). The plan's "no DB migrations" constraint must
break here. Current `audit_log` indexes are only on
`actor_user_id`, `action`, `ts` (verified at
`server/db/schema.ts:286-305`). Without `(task_id, action)`:

- The page already runs one `audit_log.where(taskId AND action)
  .limit(1)` query at `app/cards/[id]/page.tsx:113-123`.
- Phase 3 adds two more (`awaitingImplementationApproval`,
  `implementationFinalised`).
- Each falls back to `audit_log_action_idx` and filters by
  `task_id` post-fetch — unbounded as the table grows.
- At ~5k audit rows (≈250 tasks at typical density), per-helper
  cost goes from sub-ms to 10-50ms. Card-detail render gets +30-150ms.

**Required:** ship `0003_audit_log_task_action_idx.sql` migration
adding `index("audit_log_task_action_idx").on(taskId, action)`.
Add to Phase 2.

**Cycle helpers must filter `runs.supersededAt IS NULL`**
(data-integrity SEV-2). Current `taskCycleCount` plan-sketch counts
ALL brainstorm rows including superseded ones. A manually re-run
brainstorm during cycle 2 would bump count from 2 to 3 and
mis-classify the cycle. The fix is one WHERE clause; document the
invariant: "a cycle is bounded by a *non-superseded* brainstorm
run-start."

**Read `currentCycleNumber` INSIDE `withRunLock`, not at the
endpoint** (data-integrity SEV-1). The plan's current shape:

```typescript
// WRONG — race window between read and lock acquisition
const cycle = currentCycleNumber(taskId);
const result = cycle > 1
  ? await withRunLock(`approve:${taskId}`, () => approveCycle(...))
  : await withRunLock(`approve:${taskId}`, () => approveAndPr(...));
```

**Corrected shape:**

```typescript
// Single approveTask that dispatches inside the lock
const result = await withRunLock(`approve:${taskId}`, async () => {
  const cycle = currentCycleNumber(taskId);  // inside lock
  return cycle > 1
    ? approveCycle(taskId, user.id)
    : approveAndPr(taskId, user.id);
});
```

The race: brainstorm POST (different lock key) inserts a new
`runs` row between the read and the lock. cycleNumber=1 path runs
against artifacts that already belong to cycle 2 — pr_records
state is dirtied by `approveAndPr` when `approveCycle` should
have run.

**Promote Risk #3's dedup audit check to a Phase 4 ACCEPTANCE
CRITERION** (data-integrity, security M1). The current plan
defers it as "optional polish." It's not. Without it:

- `approveCycle` writes file → commits → push fails (network) →
  retry: clean tree, no-op commit, push succeeds, posts SECOND
  Jira comment.
- Or worse: push succeeds but lane update fails → operator
  re-clicks → posts THIRD Jira comment.

**Required Phase 4 implementation:**

```typescript
// server/git/approveCycle.ts — before postComment
const cycle = currentCycleNumber(taskId);
const alreadyPosted = db
  .select({ id: auditLog.id })
  .from(auditLog)
  .where(
    and(
      eq(auditLog.taskId, taskId),
      eq(auditLog.action, "approve.completed"),
      sql`json_extract(payload_json, '$.cycleNumber') = ${cycle}`,
      sql`json_extract(payload_json, '$.jiraCommentId') IS NOT NULL`,
    ),
  )
  .limit(1)
  .all();

if (alreadyPosted.length === 0) {
  jiraCommentId = await postComment(jiraKey, body);
}
```

Same dedup before the lane transition (`tasks.currentLane = "pr"`).

**Wrap `task.implementation_complete` audit + lane update in
`db.transaction`** (data-integrity SEV-2). Today's
`implementComplete.ts:247-256` does NOT atomically commit them:

```typescript
// CURRENT — two sequential statements, not atomic
db.update(tasks).set({ currentLane: "done" }).where(...);
audit({ action: "task.implementation_complete", ... });

// CORRECT — wrap in transaction
db.transaction((tx) => {
  tx.update(tasks).set({ currentLane: "done" }).where(...);
  tx.insert(auditLog).values({ action: "task.implementation_complete", ... });
});
```

Crash between the two leaves lane=`done` with no audit row —
cycle helpers see `cycleNumber=N` correctly but
`implementationFinalised` returns false → "approve implementation"
button shows on a task that's already done.

**Use existing audit action names with payload-based variants**
(pattern-recognition):

| Plan proposed | Existing convention | Use |
|---|---|---|
| `approve.cycle_completed` | `approve.completed` | `approve.completed` with `payload.cycleNumber` |
| `preview.force_switched` | `preview.switched` | `preview.switched` with `payload.force: true` |

This also makes the dedup query simpler (one action name, query by
`payload.cycleNumber`).

**Architecture: extract `server/git/approveSteps.ts`**
(architecture-strategist, code-simplicity, pattern-recognition).
~80% of `approveCycle`'s body is the same prelude as `approveAndPr`
(validate task, worktree, artifacts; write MDs to worktree;
git add/commit; push). Without extraction, every future change to
artifact persistence semantics is a two-place edit and the two
functions WILL drift.

```typescript
// server/git/approveSteps.ts (NEW)
export async function writeArtifactsToWorktree(wt, artifacts): Promise<void>;
export async function commitIfDirty(wt, jiraKey, title): Promise<{
  sha: string; createdNew: boolean;
}>;
export async function findOrCreatePr(wt, branch, ...): Promise<{
  url: string; created: boolean;
}>;
```

`approveAndPr` keeps its `prRecords.state`-driven step machine for
resumable cycle 1; `approveCycle` calls the same primitives without
the state checkpoints. Cycle 2's no-op-push optimization (skip push
when `git rev-parse HEAD == origin/branch`) lives in `commitIfDirty`
and benefits both paths.

**Collapse three cycle helpers into one snapshot**
(kieran-ts, code-simplicity, performance):

```typescript
// server/lib/taskCycle.ts — single helper, single query
export type CycleContext = {
  count: number;       // 0 = never started
  number: number;      // alias for count, named for read sites
  startedAt: Date;     // task.createdAt fallback when count === 0
};

export function getCycleContext(taskId: string): CycleContext {
  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      latestStartedAt: sql<number | null>`MAX(started_at)`,
    })
    .from(runs)
    .where(and(
      eq(runs.taskId, taskId),
      eq(runs.lane, "brainstorm"),
      isNull(runs.supersededAt),    // SEV-2 fix
    ))
    .get();
  // ...returns CycleContext
}
```

One query instead of three; "0 = never started" sentinel lives in
one type instead of three docstrings.

**Lane-role keying for customizable-workflow compatibility**
(architecture-strategist). `runs.lane === "brainstorm"` breaks if
operators rename the lane. Make the helper accept a lane-role
predicate so the customizable-workflow branch can swap in
`lanes.role === "cycle_start"` later:

```typescript
// server/lib/taskCycle.ts — abstracted
const CYCLE_START_LANES = ["brainstorm"] as const;  // v1: hardcoded
// v2 (with customizable-workflow): query lanes WHERE role = 'cycle_start'

export function getCycleContext(taskId: string): CycleContext {
  // ...uses CYCLE_START_LANES.includes(runs.lane)
}
```

Document at the constant: "swap to lane-role lookup when
customizable-workflow lands."

### Layer C — destructive-operation hardening

**CSRF guard on the destructive `/preview` force endpoint**
(security H1). `withAuth` checks the JWT session cookie but does
NOT verify Origin/Referer. A destructive endpoint that discards
uncommitted work needs an additional guard:

```typescript
// app/api/tasks/[id]/preview/route.ts
const origin = req.headers.get("origin");
const referer = req.headers.get("referer");
const expectedOrigin = env.AUTH_URL ?? `https://${req.headers.get("host")}`;

if (force) {
  if (!origin || new URL(origin).host !== new URL(expectedOrigin).host) {
    throw new Forbidden("force-switch requires same-origin request");
  }
  // Or: require X-Requested-With: XMLHttpRequest header that
  // browsers won't add cross-origin without preflight.
}
```

**`git stash create` before `git checkout -f`** (security H2).
The dangling stash commit is recoverable via `git reflog` for
~14 days. Add the stash SHA to the audit payload so post-incident
recovery is possible:

```typescript
// app/api/tasks/[id]/preview/route.ts
if (force && dirty.length > 0) {
  const { stdout: stashSha } = await exec(
    "git", ["stash", "create", "force-switch backup"], { cwd },
  );
  audit({
    action: "preview.switched",
    actorUserId: user.id,
    taskId,
    payload: {
      branch: pr.branch,
      force: true,
      dirtyCount: dirty.length,
      dirtyFiles: dirty,                  // not just count
      backupStashSha: stashSha.trim(),    // recoverable via reflog
    },
  });
}
```

**Show only counts in the operator-facing modal, full paths server-
side only** (security H3). The current plan's "list dirty file paths
to the operator" leaks unreleased feature names across operators
sharing `PREVIEW_DEV_PATH`. Compromise: show counts to the operator
("3 tracked files would be discarded"), record full paths in the
audit row.

### Layer A and B — minor TypeScript hygiene

(kieran-typescript-reviewer)

- Type the audit-log payload at the seam:

```typescript
// server/auth/auditPayloads.ts (NEW)
export const RunStartedRequest = z.object({
  qaFixCycle: z.boolean().optional(),
  qaCommentIds: z.array(z.string()).optional(),
  qaCycleNumber: z.number().int().nonnegative().optional(),
  cycleNumber: z.number().int().nonnegative().optional(),
}).passthrough();
```

Replaces inline casts at every audit-payload read site.

- `ApproveButton` `cycleNumber` should be `cycleNumber?: number`
  with `cycleNumber ?? 1` at the label site so existing call sites
  don't churn.
- `approveCycle` should throw uniformly (via existing
  `BadRequest`/`AppError` taxonomy) rather than returning the
  discriminated `ApproveResult` union — it has no resumable state
  to communicate.

### Items DROPPED based on simplicity review

- **`cyclePushedCommentDoc.ts` as a separate file** → inline into
  `server/jira/adf.ts` next to `prCommentDoc` (extend the existing
  helper with optional `cycleNumber` parameter).
- **`ScopeToggle.tsx` as a separate file** → inline into
  `RunLog.tsx`. Used in exactly one place.
- **`scripts/smoke-card-detail.sh`** (Phase 7) → cut. Integration
  test #2 covers the cycle-2 happy path; manual verification
  covers the rest.
- **`docs/runbooks/multi-cycle-tasks.md`** (Phase 7) → cut for v1.
  Operator IS the deployer; README + code comments suffice. Add
  later if a second operator joins.

These cuts save ~5h of Phase 7 work and one shell script + one doc
to maintain. They're absorbed into the original plan's existing
phases.

---

## Overview

Five real-world bugs observed by the operator on the card-detail
surface, clustered into three groups by root cause (see review:
`docs/reviews/2026-05-01-card-detail-bugs-review.md`):

| Group | Issues | Root cause |
|---|---|---|
| **A. Client-state coherence** | 1, 5 | `router.refresh()` is the only mechanism for learning new runIds; it's slow + races with SSE. ChatBox wraps it in `startTransition`, freezing the UI on every send. |
| **B. Multi-cycle gating** | 2 | UI predicates (`implementStarted`, `awaitingImplementationApproval`, `implementationFinalised`) aren't cycle-scoped. `approveAndPr` is sticky-idempotent on `prRecords.state`. Once the first cycle reaches `done`, all post-review buttons hide forever. |
| **C. Standalone UX** | 3, 4 | Run log defaults to "all runs" (intentional, aged poorly); Preview-dev's dirty-tree check has no escape hatch for machine-generated cruft. |

**Group B is the "multi-cycle support" extracted slice** — cycle-
scoped UI gating + parallel `approveCycle` function — without the
QA-comment-picker entry point from the deferred QA-fix loop plan
(`docs/plans/2026-05-01-feat-qa-failed-fix-loop-plan.md`). The
helpers are kept generic (`taskCycle.ts`, not `qaCycle.ts`) so when
QA-fix lands later, it lifts on the same substrate without
rewiring.

This is **the smallest concrete shape** that resolves all five bugs.
No DB migrations. No new agents. No new external dependencies. All
fixes localised to React components, the message endpoint client
wiring, two new server-side helper modules, and the preview-dev API
route.

## Problem Statement

The five bugs in `docs/reviews/2026-05-01-card-detail-bugs-review.md`
share three properties that argue for fixing them together:

1. **All five touch the card-detail surface.** A reviewer / QA
   approver inevitably sees them all in one session of using the
   product.
2. **Group A bugs are visible on every chat send.** That is "every
   time the operator interacts with a running agent" — a
   trust-eroding bug at the busiest interaction point.
3. **Group B bug blocks the operator from running a second cycle
   *at all*.** Once a card reaches `done`, it cannot run another
   brainstorm → plan → review → implement loop without a code
   change. The agent prompt forbids commit/push (correctly), the
   `Approve Implementation` button is sticky-hidden after cycle 1,
   and `approveAndPr` is sticky-idempotent — three independent
   stuck-states that all need lifting before re-cycling works.

The cost of NOT fixing these is high: every operator session
encounters at least Group A; every multi-cycle workflow encounters
Group B; Groups C are mild irritants that compound the perception
that the surface is half-finished. Cumulative effect over two weeks
of normal use is "this product doesn't quite work."

## Proposed Solution

Three layers, shipped as one PR but built in phases so each layer
is testable in isolation.

### Layer A — Client-state coherence (Issues 1, 5)

Read the new runId from `/api/runs/[id]/message`'s response body
(the endpoint already returns it; the client throws it away today).
Stop wrapping `router.refresh()` in `startTransition` so the Send
button isn't frozen on the server-render round-trip. Hold
`currentRunId` in client-side state at the card-detail chrome
level so `RunLog` can rebind via prop change rather than waiting
for the page query to re-derive it.

### Layer B — Multi-cycle support (Issue 2)

Introduce a generic cycle concept: **a "cycle" is bounded by a
brainstorm run-start at the head and the next
`task.implementation_complete` at the tail**. New helpers in
`server/lib/taskCycle.ts` let any caller ask "when did the current
cycle start?" and "what cycle number is this?" Cycle-scope the
three sticky UI gating predicates so post-review buttons re-appear
correctly on cycles N>1. Add a parallel `approveCycle` function
that runs the same artifact-write/commit/push steps as
`approveAndPr` without the `prRecords.state` idempotency lock —
called by the same `/api/tasks/[id]/approve` endpoint when the
helper says cycle > 1.

### Layer C — Standalone UX fixes (Issues 3, 4)

Run log defaults to "current run only" with a "Show full thread"
toggle persisted to localStorage. Preview Dev gains a "Force
switch (discard N changes)" confirmation flow when the dirty-tree
check trips.

## Technical Approach

### Architecture

The three layers are independent at the seams:

```
┌── Layer A ──────────────────────────────────────────────────┐
│ ChatBox → reads body.runId from POST response               │
│         → onRunIdChanged(newId) propagates up               │
│ Card chrome holds currentRunId in client state              │
│ RunLog re-binds SSE on runId prop change (already does)     │
└─────────────────────────────────────────────────────────────┘
┌── Layer B ──────────────────────────────────────────────────┐
│ server/lib/taskCycle.ts — generic cycle helpers             │
│ app/cards/[id]/page.tsx — cycle-scope sticky predicates     │
│ /api/tasks/[id]/approve — branch on cycle > 1               │
│ server/git/approveCycle.ts — parallel approval function     │
└─────────────────────────────────────────────────────────────┘
┌── Layer C ──────────────────────────────────────────────────┐
│ RunLog — scope toggle + localStorage                        │
│ PreviewDevButton + /api/tasks/[id]/preview — { force: true }│
└─────────────────────────────────────────────────────────────┘
```

### Cycle concept (Layer B's structuring decision)

Today the system has no first-class concept of "cycle." Today's
"sticky" gating logic implicitly assumes one cycle per task. The
fix is a new abstraction:

```typescript
// server/lib/taskCycle.ts (NEW)

/** Number of brainstorm runs on this task. Cycle 1 = original
 *  flow; cycle 2 = first re-cycle, etc. Returns 0 for tasks that
 *  haven't reached the brainstorm lane yet. */
export function taskCycleCount(taskId: string): number;

/** The most-recent brainstorm run's `started_at`, or
 *  task.createdAt if no brainstorm has run yet. Used to scope
 *  predicates that should only consider runs/audit-rows from
 *  the current cycle. */
export function currentCycleStartedAt(taskId: string): Date;

/** Convenience: same as taskCycleCount, named for read sites
 *  that want the human number ("cycle 2"). */
export function currentCycleNumber(taskId: string): number;
```

These three helpers are pure DB reads; no caching needed (audit
log is small per task; cycles are rare events).

### Layer A wire details

The message endpoint at `app/api/runs/[id]/message/route.ts:75-93`
already returns `{ runId: result.runId }`. The wire change:

```typescript
// components/card-detail/ChatBox.tsx (MODIFIED)
type Props = {
  runId: string;
  canSend: boolean;
  blockedReason?: string;
  onRunIdChanged: (newRunId: string) => void;  // NEW
};

const send = () => {
  const trimmed = text.trim();
  if (!trimmed) return;
  setError(null);
  setLocalUnlock(false);
  startTransition(async () => {
    const res = await fetch(`/api/runs/${runId}/message`, { ... });
    if (!res.ok) { ... return; }
    setText("");
    const body = await res.json() as { runId: string };
    onRunIdChanged(body.runId);
  });
  // OUTSIDE the transition — fire-and-forget, doesn't gate `pending`
  router.refresh();
};
```

The card-detail page wraps `RunLog` + `ChatBox` in a thin client
chrome that holds `currentRunId` in `useState`:

```tsx
// components/card-detail/CardThread.tsx (NEW)
"use client";
export function CardThread({ initialRunId, ...props }) {
  const [runId, setRunId] = useState(initialRunId);
  return (
    <>
      <RunLog runId={runId} {...props} />
      <ChatBox runId={runId} onRunIdChanged={setRunId} {...props} />
    </>
  );
}
```

`app/cards/[id]/page.tsx` swaps the inline `<RunLog>` + `<ChatBox>`
pair for `<CardThread initialRunId={task.currentRunId}>`. RunLog's
existing `useEffect([runId])` already closes the old SSE and opens
a new one when `runId` changes — no RunLog change needed.

### Layer B — `approveCycle` shape

`server/git/approveCycle.ts` is modeled on `approveAndPr` but
omits the `prRecords.state`-driven step gating:

```typescript
// server/git/approveCycle.ts (NEW)
export async function approveCycle(
  taskId: string,
  actorUserId: string,
): Promise<ApproveResult> {
  // Same prelude as approveAndPr: validate task + worktree + artifacts.
  const task = ...;
  const wt = ...;
  const latestArtifacts = latestArtifactPerKind(taskId);
  for (const kind of REQUIRED_KINDS) {
    const a = latestArtifacts.get(kind);
    if (!a) throw new BadRequest(`missing required ${kind}`);
    if (a.isStale) throw new BadRequest(`${kind} stale; re-run before approve`);
  }

  // Step 1-3: write MDs → commit → push (always run; no state gating)
  await writeArtifactsToWorktree(wt.path, latestArtifacts);
  const commitSha = await commitIfDirty(wt.path, task.jiraKey, task.title);
  await robustPush(wt.path, branch);

  // Step 4: PR — find existing, never create
  const prUrl = await findExistingPrUrl(branch, wt.path);
  if (!prUrl) throw new AppError("no PR exists for this branch");

  // Step 5: Jira comment — post a "cycle N pushed" version
  let jiraCommentId: string | null = null;
  let jiraWarning: string | null = null;
  try {
    const cycle = currentCycleNumber(taskId);
    const body = cyclePushedCommentDoc({
      prUrl, jiraKey: task.jiraKey, title: task.title,
      cycleNumber: cycle,
      artifacts: artifactsForComment(latestArtifacts),
    });
    jiraCommentId = await postComment(task.jiraKey, body);
  } catch (err) {
    jiraWarning = `Jira comment failed: ${(err as Error).message}`;
  }

  // Lane transition
  db.update(tasks).set({ currentLane: "pr" }).where(...);
  audit({ action: "approve.cycle_completed", actorUserId, taskId,
          payload: { cycleNumber, prUrl, commitSha } });

  return { ok: true, prUrl, commitSha, jiraCommentId, jiraWarning };
}
```

The approve endpoint (`app/api/tasks/[id]/approve/route.ts`)
branches on `currentCycleNumber(taskId) > 1`:

```typescript
const cycle = currentCycleNumber(taskId);
const result = cycle > 1
  ? await withRunLock(`approve:${taskId}`, () => approveCycle(taskId, user.id))
  : await withRunLock(`approve:${taskId}`, () => approveAndPr(taskId, user.id));
```

`approveAndPr` stays unchanged for cycle 1.

### Layer B — UI gating predicates (cycle-scoped)

`app/cards/[id]/page.tsx` currently:

```typescript
implementStarted = allRuns.some(r =>
  r.lane === "implement" &&
  (r.status === "running" || r.status === "awaiting_input" || r.status === "completed")
);
```

After fix:

```typescript
const cycleStart = currentCycleStartedAt(task.id);

implementStarted = allRuns.some(r =>
  r.lane === "implement" &&
  r.startedAt.getTime() >= cycleStart.getTime() &&
  (r.status === "running" || r.status === "awaiting_input" || r.status === "completed")
);

awaitingImplementationApproval = auditRows.some(r =>
  r.action === "implement.awaiting_approval" &&
  r.createdAt.getTime() >= cycleStart.getTime()
);

implementationFinalised = auditRows.some(r =>
  r.action === "task.implementation_complete" &&
  r.createdAt.getTime() >= cycleStart.getTime()
);
```

The `ApproveButton` doesn't need cycle-scoped visibility logic —
it's already gated on `gate.brainstorm.present && gate.plan.present
&& !stale` which is naturally cycle-correct (cycle 2's
brainstorm/plan/review become the latest after their re-runs).
The button label changes:

```tsx
<ApproveButton
  taskId={task.id}
  prRecord={prRecordDTO}
  gate={gate}
  canControl={canControl}
  cycleNumber={currentCycleNumber(task.id)}  // NEW
/>
// ...inside ApproveButton:
const label = cycleNumber > 1 ? `Push cycle ${cycleNumber} to PR` : "Approve & PR";
```

### Layer C — Run log scope toggle

`components/card-detail/RunLog.tsx`'s `EventStream` filters
`state.events` to `runId === currentRunId` by default. A small
`<ScopeToggle>` component above the log panel switches between
"This run" and "Full thread", persisted to localStorage:

```typescript
// components/card-detail/RunLog.tsx (MODIFIED)
const [scopeMode, setScopeMode] = useState<"current" | "full">(() =>
  (localStorage.getItem("runLog.scope") as "current" | "full") ?? "current",
);

useEffect(() => {
  localStorage.setItem("runLog.scope", scopeMode);
}, [scopeMode]);

const visibleEvents = scopeMode === "current"
  ? state.events.filter(e => e.runId === runId)
  : state.events;

// ...pass visibleEvents to <EventStream>
```

The `RunHeader` per-run separators only render in "Full thread"
mode (in "Current" mode there's only one run group, no header
needed).

### Layer C — Preview Dev force-switch

`/api/tasks/[id]/preview` accepts an optional `{ force: true }`
in the request body. When set, the dirty-tree check is skipped
and the server runs `git checkout -f <branch>` (or `git reset
--hard HEAD && git checkout <branch>`) before the standard
fetch+checkout flow.

```typescript
// app/api/tasks/[id]/preview/route.ts (MODIFIED)
const body = await req.json().catch(() => ({}));
const force = body?.force === true;

if (!force) {
  // existing dirty-tree check
  const dirty = ...;
  if (dirty.length > 0) {
    throw new Conflict(`preview dev has uncommitted changes:\n${dirty.join("\n")}\nPass {force:true} to discard.`);
  }
}

// existing fetch
await exec("git", ["fetch", "origin", pr.branch], { cwd });

// checkout — if force, use -f to discard
if (force) {
  await exec("git", ["checkout", "-f", pr.branch], { cwd });
  audit({ action: "preview.force_switched", actorUserId: user.id,
          taskId, payload: { branch: pr.branch, dirtyCount: ... } });
} else {
  await exec("git", ["checkout", pr.branch], { cwd });
}
```

`PreviewDevButton.tsx` handles the 409 by surfacing a confirmation
flow:

```typescript
if (!res.ok && res.status === 409) {
  const body = await res.json();
  setForcePrompt({
    message: body.message,
    onConfirm: () => doSwitch({ force: true }),
  });
  return;
}
```

A small inline `<ForceSwitchConfirm>` component renders the prompt
inside the card's action area (or as a HeroUI Modal — match the
existing pattern in the codebase).

### Implementation phases

Total: ~3.5–4 days. Phases 1+2 can interleave; phases 3+4 build on
2; phases 5+6 are independent of all the rest.

#### Phase 1: Layer A — chat send + new run display (Day 1, ~4h)

Files:
- `components/card-detail/ChatBox.tsx` — read body.runId from POST
  response; call new `onRunIdChanged` prop; move `router.refresh()`
  outside `startTransition`.
- **NEW** `components/card-detail/CardThread.tsx` — client wrapper
  holding `currentRunId` in useState; renders `<RunLog>` +
  `<ChatBox>` and forwards `setRunId` as `onRunIdChanged`.
- `app/cards/[id]/page.tsx` — replace the inline `<RunLog>` +
  `<ChatBox>` pair with `<CardThread>`. Pass `task.currentRunId` as
  `initialRunId`.
- **NEW** `tests/chatBoxRunIdRebind.test.ts` — mock POST returning
  `{ runId: "new-id" }`; assert `onRunIdChanged` fires with the new
  id; assert `pending` clears within tick of POST resolution
  (independent of router.refresh).

Acceptance:
- [ ] Send button returns to ready state within 200ms of POST
  response (not coupled to router.refresh duration).
- [ ] Textarea is enabled within 200ms of POST response — operator
  can type the next message immediately.
- [ ] New runId is bound to RunLog within 1s — "👤 you" bubble +
  new turn render without a manual page reload.
- [ ] Existing chat-send behaviour preserved on rate-limit (429),
  validation errors, and network failures (text not cleared,
  error surfaced in inline banner).

#### Phase 2: Layer B substrate — cycle helpers (Day 1, ~3h)

Files:
- **NEW** `server/lib/taskCycle.ts` — `taskCycleCount`,
  `currentCycleStartedAt`, `currentCycleNumber`. Each is a small
  Drizzle query.
- **NEW** `tests/taskCycle.test.ts` — round-trip every helper
  against fixture audit / runs rows.

Acceptance:
- [ ] `taskCycleCount(taskId)` returns count of `runs` rows with
  `lane === "brainstorm"` for the task. 0 for unstarted tasks.
- [ ] `currentCycleStartedAt(taskId)` returns max(brainstorm
  run.started_at), or task.createdAt if no brainstorm yet.
- [ ] `currentCycleNumber(taskId)` matches `taskCycleCount`.

#### Phase 3: Layer B — cycle-scoped UI gating (Day 2, ~5h)

Files:
- `app/cards/[id]/page.tsx` — compute `cycleStart` and
  `cycleNumber`; cycle-scope `implementStarted`,
  `awaitingImplementationApproval`, `implementationFinalised`;
  thread `cycleNumber` into `ApproveButton`,
  `ImplementButton`, `ApproveImplementationButton`.
- `components/card-detail/ApproveButton.tsx` — accept
  `cycleNumber` prop; label switches to "Push cycle N to PR" for
  N>1.
- `components/card-detail/ImplementButton.tsx` — no internal
  change (predicate fix is in the page).
- `components/card-detail/ApproveImplementationButton.tsx` — no
  internal change.

Acceptance:
- [ ] After cycle 1 reaches `done`, starting a brainstorm run
  shows the brainstorm-running state. Cascade reaches review.
- [ ] On cycle 2 review completion, ApproveButton is visible
  with label "Push cycle 2 to PR".
- [ ] After cycle 2's ce:work completes, ImplementButton hides
  (cycle-2 run completed) AND ApproveImplementationButton
  appears.
- [ ] Cycle 1 behaviour on the same surface unchanged
  (regression test).

#### Phase 4: Layer B — `approveCycle` + endpoint branching (Day 2-3, ~5h)

Files:
- **NEW** `server/git/approveCycle.ts` — the parallel approval
  function described above. Reads latest artifacts, writes to
  worktree, commits, pushes, finds existing PR, posts cycle-
  pushed Jira comment, sets lane=`pr`. Audits
  `approve.cycle_completed`.
- **NEW** `server/jira/cyclePushedComment.ts` — `cyclePushedCommentDoc({
  prUrl, jiraKey, title, cycleNumber, artifacts })` — ADF helper
  that produces "Cycle N pushed to PR" comment with the cycle
  number in the heading.
- `app/api/tasks/[id]/approve/route.ts` — branch on
  `currentCycleNumber(taskId) > 1` to call `approveCycle` instead
  of `approveAndPr`.
- **NEW** `tests/approveCycle.test.ts` — fixture: task with
  cycle 1 already completed, cycle 2 in `review`. POST
  `/approve`. Assert: artifacts re-written to worktree,
  one new commit, push attempted, Jira comment posted with
  cycle 2 wording, lane=`pr`.

Acceptance:
- [ ] `approveCycle` runs all artifact-write/commit/push steps
  regardless of `prRecords.state`.
- [ ] Existing PR is reused (no new PR creation attempted).
- [ ] Jira comment uses cycle-N wording.
- [ ] Cycle 1 path (`approveAndPr`) regression-tests green.
- [ ] Concurrent Approve & PR clicks serialise via `withRunLock`.

#### Phase 5: Layer C — run log scope toggle (Day 3, ~3-4h)

Files:
- `components/card-detail/RunLog.tsx` — add `scopeMode` state +
  localStorage persistence; filter `state.events` based on mode;
  render `<ScopeToggle>` above the log panel.
- **NEW** `components/card-detail/ScopeToggle.tsx` — small
  segmented control: "This run" / "Full thread".
- `tests/runLogScope.test.ts` — render with multi-run threadEvents,
  assert default shows only current run; toggle reveals all.

Acceptance:
- [ ] Default mode shows only events from the current runId.
- [ ] "Show full thread" toggle reveals prior runs with
  `RunHeader` separators.
- [ ] Preference persists across page reloads via localStorage.
- [ ] Falls back to default if localStorage unavailable.

#### Phase 6: Layer C — preview dev force-switch (Day 3, ~3-4h)

Files:
- `app/api/tasks/[id]/preview/route.ts` — accept `{ force: true }`;
  skip dirty check; use `git checkout -f`; audit
  `preview.force_switched`.
- `components/card-detail/PreviewDevButton.tsx` — handle 409
  response by entering a "force confirm" mode with the dirty file
  list; on confirm, retry POST with `force: true`.
- **NEW** `components/card-detail/ForceSwitchConfirm.tsx` —
  destructive-intent confirmation surfaced inline; lists the
  dirty files; "Discard changes and switch" button.
- `tests/previewForceSwitch.test.ts` — fixture: dirty preview
  dir; first POST returns 409; second POST with `force: true`
  invokes `git checkout -f` (mocked), audit row written.

Acceptance:
- [ ] First POST with dirty tree returns 409 with file list
  (existing behaviour preserved).
- [ ] PreviewDevButton displays the file list with a destructive-
  intent confirm button.
- [ ] Confirming POSTs `{ force: true }` and switches.
- [ ] Audit row `preview.force_switched` records the dirty count.

#### Phase 7: Tests + smoke + docs (Day 4, ~4h)

Files:
- **NEW** `tests/multiCycleIntegration.test.ts` — end-to-end:
  task created, cycle 1 reaches done; start cycle 2 brainstorm →
  cascade → approve → implement → approve-implementation; assert
  cycle 2 commits land on PR, lane=done.
- **NEW** `scripts/smoke-card-detail.sh` — fresh DB, run cycle 1
  via API, run cycle 2 via API, assert PR has commits from both
  cycles + correct Jira comment shapes.
- `README.md` — Pages section: note multi-cycle support, run-log
  scope toggle.
- `docs/install-checklist.md` — mention preview-dev force-switch.
- **NEW** `docs/runbooks/multi-cycle-tasks.md` — operator runbook:
  how to run a second cycle, what the cycle counter means, how
  to recover from a stuck cycle.

Acceptance:
- [ ] All existing vitest tests still green.
- [ ] At least 8 new tests across the 6 phases.
- [ ] Smoke script passes end-to-end.
- [ ] README + install checklist + runbook updated.

## Alternative Approaches Considered

### A. Reset `prRecords.state` to `'drafting'` on cycle 2 start

Single-function path through `approveAndPr`, no new file. The
brainstorm run-start (or auto-advance into it) would also reset
the prRecords row.

**Skipped:** couples brainstorm-start logic to PR state. Hard to
test in isolation. The parallel `approveCycle` keeps each function
single-purpose and lets the cycle 1 path stay regression-pinned.

### B. Add a `forceRefresh: boolean` parameter to `approveAndPr`

Single-function path, single call site, branch internally on the
boolean.

**Skipped:** approveAndPr's idempotency-by-state model is the
*reason* it works for cycle 1's resumable-on-failure semantics
(the route can be retried after each step's failure to resume from
where it left off). Adding a "force" branch undermines that
property and makes the function harder to reason about.

### C. Task-level SSE stream (`/api/tasks/[id]/stream`)

Push-based notification of `tasks.currentRunId` changes. Card-
detail page subscribes once at mount; new runIds arrive without
relying on `router.refresh()` at all.

**Skipped for v1, kept as future:** the Layer A cheap path (read
runId from POST response + drop transition wrapping) resolves the
visible symptoms with much less code. Task SSE is the right
long-term fix for residual edge cases (auto-advance creating a new
run while the operator is on a different tab) — punt to v2 once we
have signal that the cheap fix isn't enough.

### D. Force scope toggle to operator action only (no localStorage)

Don't persist the run log scope; default to "current run" always.

**Skipped:** operators who *want* the full thread view (e.g.,
QA-fix re-cycle audit) shouldn't have to toggle every page load.
localStorage is a one-line change.

### E. Refuse force-switch on Preview Dev entirely

Operator must manually clean the working tree.

**Skipped:** the 95%+ case is machine-generated cruft (Yii2 cache,
composer lockfile, etc.) that the operator doesn't care about.
Forcing manual cleanup is friction without value. The destructive-
intent confirmation flow keeps human work safe.

## System-Wide Impact

### Interaction Graph — Layer A

When the operator clicks Send in chat:

1. ChatBox POST `/api/runs/[id]/message`.
2. Server: `withAuth` → `withRunLock(runId)` → `resumeRun({ runId,
   prompt, ... })`.
3. `resumeRun` calls `startRun({ taskId, lane: prevRun.lane,
   agentId: prevRun.agentId, resumeSessionId: prevRun.claudeSessionId,
   ... })`.
4. `startRun` creates a NEW `runs` row with new id, sets
   `tasks.currentRunId = newRunId`, audits
   `run.started_request`, calls `spawnAgent`.
5. `resumeRun` returns `{ runId: newRunId }`.
6. Endpoint returns `{ runId: newRunId }` to client.
7. ChatBox reads body.runId, calls
   `onRunIdChanged(body.runId)`.
8. CardThread updates its `runId` state.
9. RunLog's `useEffect([runId])` closes the old SSE, opens
   `/api/runs/${newRunId}/stream`.
10. New events stream into RunLog.
11. **Independently:** `router.refresh()` (fired outside the
    transition) re-renders the server component to refresh
    artifact panel, audit log, etc. — no longer gates `pending`.

### Interaction Graph — Layer B

When the operator runs cycle 2:

1. Card on `done` lane after cycle 1.
2. Operator clicks Run → Brainstorm → POST `/api/tasks/[id]/runs`.
3. `startRun({ taskId, lane: "brainstorm", agentId: "ce:brainstorm",
   ... })` runs. New brainstorm `runs` row inserted; lane → brainstorm.
4. `taskCycleCount(taskId)` is now 2.
5. ce:brainstorm exits → autoAdvance → ce:plan → ce:review.
6. ce:review exits → autoAdvance halts at `pr` (per existing logic).
7. Card-detail page re-renders. `currentCycleNumber = 2`.
   Cycle-scoped predicates compute against `cycleStart =
   <cycle-2-brainstorm.startedAt>`. `implementStarted = false`
   (no implement runs since cycleStart). ApproveButton visible
   with label "Push cycle 2 to PR".
8. Operator clicks → POST `/api/tasks/[id]/approve`.
9. Endpoint computes `currentCycleNumber(taskId) === 2` → routes
   to `approveCycle(taskId, user.id)` instead of `approveAndPr`.
10. `approveCycle`: writes artifact MDs, commits, pushes
    (existing branch, existing PR), posts cycle-2 Jira comment,
    sets lane=`pr`.
11. Operator clicks Implement → ce:work runs → exits.
12. ApproveImplementationButton visible (cycle-scoped predicate
    matches cycle-2's awaiting_approval audit).
13. Operator clicks → POST `/api/tasks/[id]/approve-implementation`
    → `implementComplete` (unchanged) → robustPush, post
    "implementation pushed" Jira comment, attempt Jira transition
    (already in "Code Review", skipped via existing
    `transitionIssueToName` graceful no-op), lane=`done`.
14. `taskCycleCount = 2`; cycle 2's audit row
    `task.implementation_complete` exists.

### Error & Failure Propagation

| Failure | Where | Behaviour |
|---|---|---|
| Layer A: POST returns 429 | ChatBox | Existing rate-limit toast; text not cleared; runId NOT updated |
| Layer A: POST returns 200 but body has no `runId` | ChatBox | Fall back to `router.refresh()` for runId update; no rebind via state holder |
| Layer A: POST returns 200, body parse throws | ChatBox | Fall back to `router.refresh()`; log warning |
| Layer A: SSE reconnect fails on new runId | RunLog | Existing reconnect logic; "reconnecting" indicator |
| Layer B: cycle helpers throw on missing brainstorm row | server | Helpers return defaults (0, task.createdAt); never throw |
| Layer B: `approveCycle` fails at git push | endpoint | 500; toast; lane stays at review; retry idempotent |
| Layer B: `approveCycle` posts Jira comment that fails | endpoint | Non-fatal warning (matches existing behaviour); lane still moves to `pr` |
| Layer B: `approveCycle` runs on a task with no PR | endpoint | 500 `no PR exists for this branch`; documented in runbook |
| Layer B: cycle helpers cached/stale | n/a | No cache; helpers read fresh on each call |
| Layer C: localStorage unavailable | RunLog | `scopeMode` falls back to `"current"` default |
| Layer C: Preview force-switch git checkout -f fails | endpoint | 500 propagates the git error; preview path unchanged |
| Layer C: Operator confirms force-switch on a path with truly important uncommitted work | endpoint | Work lost. Mitigation: confirmation modal lists files; destructive-intent button. Documented as expected behaviour. |

### State Lifecycle Risks

| Scenario | Behaviour |
|---|---|
| Layer A: Two chat sends in quick succession | Both POSTs happen via `withRunLock(runId)` server-side which serialises. Second send waits for first to finalise. If Send button is tap-tap-tapped in <200ms window, the second tap fires while `pending=true` from the first transition (Send disabled — already prevented). |
| Layer A: Page refresh between POST and `onRunIdChanged` | `tasks.currentRunId` is set by `startRun` before the POST returns. Server query on refresh reads the new id. RunLog still rebinds correctly via `initialRunId`. |
| Layer B: Operator starts cycle 2 brainstorm but doesn't approve & PR for an hour | Card sits on review. `currentCycleNumber=2`, `currentCycleStartedAt = <1h ago>`. Buttons remain visible. Worktree may be orphan-pruned (>24h). `ensureWorktree` on next run must recreate from origin (existing behaviour). |
| Layer B: Operator triggers `approveAndPr` race condition by clicking the button on cycle 2 right at the moment cycle 1's autoAdvance fires | `withRunLock("approve:${taskId}")` serialises. If the lane is in flux when the lock acquires, the artifact-staleness check catches inconsistency. |
| Layer B: Cycle 1's PR was merged externally before cycle 2 starts | Branch may be deleted from origin. `git fetch origin <branch>` fails. `git push` fails. 500 returned; operator informed. Documented in runbook as "external merge during in-flight cycle." |
| Layer C: Operator sets scope toggle to "Full thread", clears site data, returns | Falls back to "current" default. No data loss; preference resets. |
| Layer C: Force-switch while a run is in progress on the worktree path | Out of scope — `PREVIEW_DEV_PATH` is a separate path from agent worktrees. Documented as a configuration prerequisite. |

### API Surface Parity

| Surface | Today | After this plan |
|---|---|---|
| `/api/runs/[id]/message` | accepts `{ text, clientRequestId? }`; returns `{ runId }` | unchanged (client now reads the runId) |
| `/api/tasks/[id]/approve` | always calls `approveAndPr` | branches: cycle 1 → `approveAndPr`, cycle N → `approveCycle` |
| `/api/tasks/[id]/runs` | unchanged | unchanged |
| `/api/tasks/[id]/preview` | accepts no body | accepts optional `{ force: true }` |
| `/api/tasks/[id]/approve-implementation` | unchanged | unchanged (cycle awareness flows from the audit log automatically) |
| Card-detail page query (`app/cards/[id]/page.tsx`) | computes sticky predicates | computes cycle-scoped predicates via helpers |
| `ChatBox` props | `runId, canSend, blockedReason` | adds `onRunIdChanged: (id: string) => void` |
| `ApproveButton` props | `taskId, prRecord, gate, canControl` | adds `cycleNumber: number` (for label) |
| `RunLog` props | unchanged | unchanged (scope state is internal) |
| `PreviewDevButton` props | unchanged | unchanged (force flow is internal) |
| Audit log | existing actions | adds `approve.cycle_completed`, `preview.force_switched` |

### Integration Test Scenarios

`tests/cardDetailIntegration.test.ts`:

1. **Layer A — chat send rebinds runId.** Mock POST returning new
   runId. Assert `onRunIdChanged` fires; assert RunLog's
   `useEffect[runId]` re-runs (mocked EventSource closed/opened);
   assert `pending` false within tick of POST resolution.
2. **Layer B — full cycle 2 happy path.** Fixture: task with cycle
   1 in `done`. Run cycle 2 brainstorm/plan/review (via
   startRun + autoAdvance fixtures). Assert
   `currentCycleNumber=2`, predicates correctly scoped. POST
   `/approve`; assert routed to `approveCycle`. Assert artifacts
   committed, push attempted, Jira comment with cycle 2 wording.
3. **Layer B — cycle 1 regression.** Fixture: fresh task. Run
   cycle 1 to `done`. Assert: cycleNumber=1; routed to
   `approveAndPr`; behaviour byte-identical to today.
4. **Layer C — run log scope toggle.** Render RunLog with thread
   events from runs A, B, C; default mode shows only run B
   (current); toggle to "full" reveals all three with section
   headers; toggle persisted to localStorage; reload preserves.
5. **Layer C — preview dev force.** Fixture: PREVIEW_DEV_PATH
   with dirty tree. POST without force → 409 with file list.
   POST with `{force:true}` → mocked `git checkout -f` invoked,
   audit row written.

## Acceptance Criteria

### Functional Requirements

- [ ] Layer A: chat Send button returns to ready state within
  200ms of `/api/runs/[id]/message` response (independent of
  `router.refresh()` duration).
- [ ] Layer A: textarea is enabled within 200ms of POST response.
- [ ] Layer A: new runId binds to RunLog within 1s; user message
  bubble appears without manual reload.
- [ ] Layer B: after cycle 1's `done`, a fresh brainstorm run
  cascades through to `ce:work` correctly; cycle counter chip
  shows "cycle 2".
- [ ] Layer B: ApproveButton appears on cycle 2's review-complete
  state with label "Push cycle 2 to PR".
- [ ] Layer B: clicking ApproveButton on cycle 2 commits + pushes
  cycle 2 artifacts to the existing PR; Jira comment posted with
  cycle 2 wording.
- [ ] Layer B: ImplementButton + ApproveImplementationButton
  appear in correct sequence on cycle 2.
- [ ] Layer B: cycle 1 path unchanged for fresh tasks (regression
  fixture).
- [ ] Layer C: run log defaults to "current run" view; toggle
  reveals full thread.
- [ ] Layer C: scope preference persists in localStorage across
  reloads.
- [ ] Layer C: Preview Dev's first POST behaves as today on dirty
  tree (returns 409); UI surfaces a "Discard N changes and
  switch" confirmation; confirming POSTs `{force:true}` and
  switches successfully.

### Non-Functional Requirements

- [ ] No new external dependencies.
- [ ] No DB schema migrations.
- [ ] No breaking changes to existing endpoints (only additive:
  `force` body field on preview, internal branch in approve).
- [ ] Bundle size impact: <5KB gzipped on the card-detail route.
- [ ] Cycle helper queries: <2ms each on indexed task slice.
- [ ] All changes compatible with the deferred customizable-
  workflow + QA-fix branches (taskCycle helpers are workflow-
  agnostic; `approveCycle` is the same shape QA-fix would use).

### Quality Gates

- [ ] All existing vitest tests still green.
- [ ] At least 12 new tests across the six phases (was 8; deepen-plan
  raises the bar to cover the promoted-from-deferred mitigations:
  cycle dedup audit guard, supersedesAt filter, CSRF check, stash-
  before-force-switch, key-on-CardThread, atomic implement-complete
  transaction).
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` clean.
- [ ] **NEW (deepen-plan):** `0003_audit_log_task_action_idx.sql`
  migration applied; `EXPLAIN QUERY PLAN` confirms cycle helpers use
  the new index.
- [ ] **NEW (deepen-plan):** Integration test for cycle dedup —
  simulate `approveCycle` with mocked `postComment` failing on first
  attempt + succeeding on retry; assert exactly one Jira comment row.
- [ ] **NEW (deepen-plan):** Integration test for force-switch CSRF —
  POST `/api/tasks/[id]/preview` with `{force:true}` and an Origin
  header from a different host returns 403.
- [ ] **NEW (deepen-plan):** Integration test for stash-recovery —
  force-switch with dirty tree creates a stash, audit row records
  the stash SHA, `git stash list --all` shows the stash, manual
  `git stash apply <sha>` restores the changes.
- [ ] Smoke script `scripts/smoke-card-detail.sh` — **DROPPED for v1**
  (deepen-plan, simplicity #6); integration tests cover the same
  ground.
- [ ] README + install checklist updated. **Runbook DROPPED for v1**
  (deepen-plan, simplicity #7); add later if a second operator
  joins.

## Success Metrics

- **Visible-bug elimination:** zero "Sending… stuck" reports
  within 30 days of ship. Verified by absence of audit rows
  matching `chat.message_sent` followed by no `chat.message_sent`
  for >5 minutes despite a running task.
- **Multi-cycle adoption:** within 30 days, at least one task on
  the production instance has `taskCycleCount > 1`. Query:
  `SELECT count(*) FROM (SELECT task_id, count(*) AS c FROM runs
   WHERE lane='brainstorm' GROUP BY task_id HAVING c > 1)`.
- **Preview Dev force-switch usage:** the audit row
  `preview.force_switched` exists and isn't suspiciously absent
  (which would mean operators are still hitting 409 without using
  the new flow).
- **No regressions:** cycle 1 cost-per-task and time-to-PR metrics
  unchanged on the dashboard after 30 days.

## Dependencies & Prerequisites

**External:** none new.

**Internal:**
- `audit_log` with `payload_json` — shipped. **The `(task_id, action)`
  composite index is NOT shipped** (deepen-plan finding; the original
  plan's claim was wrong — verified at
  `server/db/schema.ts:286-305`). A new migration
  `0003_audit_log_task_action_idx.sql` is a hard prerequisite for
  Phase 2 — without it, every card-detail page render does 3 full-
  table scans. **The plan's "no DB migrations" constraint is broken
  here, justified by performance SLA on cycle helpers (<2ms each).**
- `runs.started_at` for cycle-scoping — shipped via
  `runs_task_lane_idx` (`task_id, lane`).
- `withRunLock`, `withAuth` — shipped. `withAuth` does NOT enforce
  Origin/Referer; deepen-plan adds an explicit guard for the
  destructive force-switch endpoint.
- HeroUI Button, TextArea — shipped.
- Existing `approveAndPr` / `implementComplete` / `startRun` /
  `autoAdvance` substrate — all shipped.
- Zod for typed audit-payload parsing — shipped (used elsewhere).

**Blocking:** the audit-log index migration is the only new
prerequisite. Trivial to ship.

## Risk Analysis & Mitigation

| # | Risk | Mitigation | Phase |
|---|---|---|---|
| 1 | Layer A's client state holder causes parent re-renders that lose RunLog scroll position or SSE state | `CardThread` uses `useState` (not context). Only the runId prop changes. RunLog's existing useEffect[runId] handles SSE rebinding cleanly. Scroll position is owned by RunLog's internal `scroller` ref — survives re-renders. | Phase 1 |
| 2 | Layer B's `currentCycleStartedAt` returns wrong value when `runs` rows have clock skew (e.g., DB clock vs app clock) | Use `runs.startedAt` consistently — single clock (better-sqlite3 unixepoch). No mixed clocks. | Phase 2 |
| 3 | Layer B `approveCycle` posts a duplicate Jira comment on partial-failure retry | **PROMOTED FROM DEFERRED → MUST SHIP IN PHASE 4** (deepen-plan: data-integrity + security M1). Without this guard, any combination of (commit succeeds + push fails + retry) or (push succeeds + lane update fails + retry) posts a second Jira comment. Mitigation: before `postComment`, query `audit_log WHERE action='approve.completed' AND payload.cycleNumber = N AND payload.jiraCommentId IS NOT NULL`; short-circuit if found. Same guard before the lane transition. Code shape in deepen-plan findings under "Promote Risk #3". | Phase 4 (mandatory) |
| 3a | NEW (deepen-plan, data-integrity SEV-2): `task.implementation_complete` audit + lane update at `implementComplete.ts:247-256` are TWO sequential statements, not atomic | Wrap in `db.transaction((tx) => { ... })`. A crash between them leaves lane=`done` with no audit row; predicates show "approve implementation" button on a finished task. | Phase 4 (mandatory) |
| 3b | NEW (deepen-plan, data-integrity SEV-1): `currentCycleNumber` race window | The endpoint reads cycleNumber, then enters lock — a concurrent brainstorm POST (different lock key) can flip the cycle between read and lock. Mitigation: read cycleNumber INSIDE the lock; or single `approveTask(taskId, actorUserId)` function that dispatches internally. | Phase 4 (mandatory) |
| 3c | NEW (deepen-plan, data-integrity SEV-2): cycle helpers don't filter `runs.supersededAt IS NULL` | Manual brainstorm re-run during cycle 2 sets supersededAt on the prior brainstorm + inserts a new row, bumping count from 2 to 3 and breaking predicates. Mitigation: `WHERE supersededAt IS NULL` clause in cycle helper queries. | Phase 2 (mandatory) |
| 4 | Layer B cycle 1 regression — `approveAndPr` accidentally branched | Endpoint test: fresh task, no brainstorm runs → cycleNumber=1 → routes to `approveAndPr`. Fixture in Phase 4. | Phase 4 |
| 5 | Layer B `approveCycle` writes artifacts to a worktree that has been orphan-pruned | `ensureWorktree` is called inside `approveCycle`'s prelude (mirroring `approveAndPr`). Recreates from origin if missing. | Phase 4 |
| 6 | Layer C run log default-to-current confuses returning operators | Toggle UX is prominent; localStorage persists per browser. Runbook documents the change. Add a one-time "We changed the default" toast on first card-detail load post-deploy (read from a feature-version flag in localStorage). Optional polish; ship without it if scope balloons. | Phase 5 |
| 7 | Layer C force-switch destroys real work | **STRENGTHENED (deepen-plan, security H2):** Confirmation modal shows file COUNTS (not paths — paths leak across operators sharing PREVIEW_DEV_PATH per security H3). Server runs `git stash create "force-switch backup"` BEFORE `git checkout -f`; records the resulting dangling stash SHA + the full file path list in audit `payload_json`. Recovery via `git reflog` works for ~14 days. | Phase 6 (mandatory) |
| 7a | NEW (deepen-plan, security H1): no CSRF guard on `/api/tasks/[id]/preview` | NextAuth's CSRF protection covers ITS OWN endpoints, not arbitrary `/api/*`. A destructive endpoint that runs `git checkout -f` on cookie auth alone is exposed to forged POSTs. Mitigation: when `force === true`, verify `req.headers.get("origin")` matches the app origin OR require an `X-Requested-With` header. Reject 403 otherwise. | Phase 6 (mandatory) |
| 8 | Layer C force-switch race: operator clicks Force just as a separate process commits to the dev path | `withAuth` route is single-request; `git checkout -f` is atomic. If the commit lands first, force-switch sees a clean tree and proceeds normally. | Phase 6 |
| 8a | NEW (deepen-plan, security M2): cross-card `CardThread` runId leakage on SPA navigation | If React reuses the same `CardThread` instance across `/cards/A` → `/cards/B` (SPA navigation, Suspense boundaries), the stale runId from card A could be sent to /api/runs/<stale>/message while operator is on card B. Mitigation: add `key={taskId}` on `<CardThread>` in the page so React forces a fresh component instance. Defense-in-depth: server-side validate `runs.taskId === url-task-id` in `/api/runs/[id]/message`. | Phase 1 (mandatory) |
| 9 | Layer A behaviour-flag rollout — new runId rebind code paths could regress on edge devices (older browsers) | `useState` + prop-passing is universally supported. No new browser APIs. Tested in jsdom (vitest) + manually in Chrome/Safari/Firefox. | Phase 1 |
| 10 | Layer B endpoint branching introduces a subtle race: `currentCycleNumber` could change between read and `withRunLock` acquisition | `currentCycleNumber` is read once before the lock, used to decide which function to call. Inside the lock, the chosen function does its own staleness checks. Worst case: cycle was 1 at read time, becomes 2 between read and lock (impossible — the brainstorm run-start that creates cycle 2 would itself need the lock to coordinate with this approve, but they use different lock keys). Still, document the race window in code comments. | Phase 4 |
| 11 | Auto-advance child runs (plan, review) running with a cycle-2 cycleStart but UI sees cycle-1 stale audit rows | Cycle helpers read `runs.lane === "brainstorm"` only — auto-advanced plan/review runs DON'T bump the cycle number. cycleStart is the brainstorm's started_at, which precedes its children. Predicates correctly scope. | Phase 2 |
| 12 | Layer B compatibility with QA-fix loop plan when it's revived | `taskCycle.ts` is intentionally generic; QA-fix's `qaCycle.ts` (proposed in the deferred plan) becomes a thin specialisation that ALSO checks `payload.qaFixCycle === true`. The cycle-scoped UI gating in this plan works for both manual cycles and QA-fix cycles unchanged. | Future |

## Resource Requirements

**Engineering:** ~3.5–4 days of focused single-engineer work.
- Day 1 morning: Phase 1 (Layer A)
- Day 1 afternoon: Phase 2 (cycle helpers)
- Day 2: Phase 3 (UI gating) + Phase 4 (approveCycle endpoint)
- Day 3: Phase 5 (run log scope) + Phase 6 (preview force)
- Day 4: Phase 7 (integration tests + smoke + docs)

**Testing:** ~half of Day 4 dedicated to tests. Existing test
fixtures cover the cycle 1 / non-Layer regression surface.

**Documentation:** ~3 hours, folded into Phase 7.

**Infra:** none.

## Future Considerations

**v2 polish (not in this plan):**
- Task-level SSE stream (`/api/tasks/[id]/stream`) for push-based
  runId updates — replaces residual `router.refresh()` calls and
  handles the "operator on a different tab" edge case.
- Cycle counter chip on the Board (currently only proposed for
  card detail in the QA-fix plan; would be useful in this fix
  cluster too).
- Side-by-side artifact diff between cycles (deferred from QA-fix
  plan).
- Per-cycle cost dashboard tile.
- Run log's "Full thread" mode could group runs by cycle visually
  (current plan groups by run only).

**Lift path to QA-fix loop plan:**
The deferred QA-fix plan can build on Layer B's substrate:
- `taskCycle.ts` becomes the home for both `currentCycleNumber`
  and a QA-fix-specific `wasQaFixCycleRun` (the latter checks the
  `qaFixCycle: true` audit payload key).
- `approveCycle` is reused for QA cycles too (only difference:
  Jira comment wording).
- `currentCycleStartedAt` works for both manual cycles and
  QA-triggered cycles unchanged.
This keeps QA-fix's later landing as a pure addition, not a refactor.

**Lift path to customizable-workflow branch:**
Cycle helpers are workflow-agnostic (read `runs.lane` and audit
log). The customizable-workflow branch's lane editor doesn't
affect this plan's correctness because the rails (ticket, branch,
pr, done) are fixed in both designs, and cycle counting tracks
brainstorm-lane runs which exist in both.

## Documentation Plan

| Doc | Change |
|---|---|
| `README.md` | Note multi-cycle support + run-log scope toggle on the Pages → Card detail line |
| `docs/install-checklist.md` | Mention preview-dev force-switch UX in step 6 |
| `docs/runbooks/multi-cycle-tasks.md` (NEW) | Operator runbook: starting cycle 2, what the cycle counter means, recovering from a stuck cycle, external-merge scenario |
| `docs/reviews/2026-05-01-card-detail-bugs-review.md` | Add "Resolved by docs/plans/2026-05-01-fix-card-detail-bug-cluster-plan.md" link at the top once shipped |
| Code comment in `server/lib/taskCycle.ts` | Explain the audit-log-derived cycle model; note QA-fix lift path |
| Code comment in `server/git/approveCycle.ts` | Explain why parallel function vs `forceRefresh` flag on `approveAndPr` |
| Code comment in `components/card-detail/CardThread.tsx` | Explain why client-side runId state holder (rather than `router.refresh()` round-trip) |

## Sources & References

### Origin

- **Review document:** [docs/reviews/2026-05-01-card-detail-bugs-review.md](../reviews/2026-05-01-card-detail-bugs-review.md). Five issues cluster:
  - Issues 1, 5 → Layer A (client-state coherence)
  - Issue 2 → Layer B (multi-cycle support)
  - Issue 3 → Layer C (run log scope)
  - Issue 4 → Layer C (preview dev force)

### Internal references

- Issue 1 root site: `components/card-detail/ChatBox.tsx:54-89`
  (the `startTransition` wrapping `router.refresh`).
- Issue 1 endpoint that returns the new runId:
  `app/api/runs/[id]/message/route.ts:75-93`.
- Issue 2 sticky predicate:
  `components/card-detail/ImplementButton.tsx:9-44`.
- Issue 2 page-level gating:
  `app/cards/[id]/page.tsx:270-296`.
- Issue 2 sticky `prRecords.state`:
  `server/git/approve.ts:65-99` (state machine).
- Issue 3 root site:
  `components/card-detail/RunLog.tsx:685-746` (EventStream
  groups events by runId for "all runs" display).
- Issue 4 dirty-tree check:
  `app/api/tasks/[id]/preview/route.ts:67-90`.
- Issue 5 root site:
  `server/worker/startRun.ts:230-233` (currentRunId update),
  `components/card-detail/RunLog.tsx:284-294` (visibility-driven
  refresh).
- Cycle helpers location:
  `server/lib/qaCycle.ts` (deferred QA-fix plan) — replaced in
  this plan by `server/lib/taskCycle.ts` (generic).
- Existing approval state machine:
  `server/git/approve.ts:50` (`approveAndPr`).
- Existing implementation finalisation:
  `server/git/implementComplete.ts:47` (`implementComplete`,
  unchanged in this plan).
- Auto-advance behaviour:
  `server/worker/autoAdvance.ts:9-17` (NEXT map; halt at `pr`).
- Audit log shape:
  `server/auth/audit.ts`, queried by helpers.
- Preview Dev button: `components/card-detail/PreviewDevButton.tsx`.
- HeroUI patterns: existing usages in `components/admin/`.

### External references

- None new. All operations use already-wired libraries.

### Related work

- Review: [docs/reviews/2026-05-01-card-detail-bugs-review.md](../reviews/2026-05-01-card-detail-bugs-review.md)
- QA-fix loop plan (deferred):
  [docs/plans/2026-05-01-feat-qa-failed-fix-loop-plan.md](2026-05-01-feat-qa-failed-fix-loop-plan.md).
  Layer B's `taskCycle.ts` + `approveCycle.ts` substrate matches
  what QA-fix needs; QA-fix lifts on top later without refactor.
- Customizable workflow v1 plan (deferred):
  [docs/plans/2026-04-24-feat-customizable-workflow-v1-plan.md](2026-04-24-feat-customizable-workflow-v1-plan.md).
  Independent — workflow rails are fixed in both designs.
- AmendPlan precedent: `components/card-detail/AmendPlanButton.tsx`,
  `server/jira/amendComment.ts`. Same shape pattern as
  `approveCycle` follows.
