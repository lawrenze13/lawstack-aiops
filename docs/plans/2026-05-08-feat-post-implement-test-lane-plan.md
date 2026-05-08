---
title: Post-Implement Test Lane (Playwright)
type: feat
status: active
date: 2026-05-08
origin: docs/brainstorms/2026-05-08-post-implement-test-lane-brainstorm.md
---

# Post-Implement Test Lane (Playwright)

## Overview

Add a new `test` lane between `implement` and `done`. After
`implementComplete.ts` finishes its 5-step Approve-Implementation
pipeline (push, undraft, PR body rewrite, Jira comment, Code Review
transition), the orchestrator auto-advances to `test` and spawns a new
`test:playwright` agent that runs the managed repo's Playwright suite
inside the per-task worktree. On PASS the lane advances to `done`. On
FAIL it holds on `test`, surfaces a Re-run button, surfaces a
"Fix from Tests" button (which reuses the merged QA-Fix-Loop with
test artifact markdown injected as findings), and exposes a manual
"Skip Tests" escape hatch.

Reports (HTML, traces, videos) copy to `TEST_REPORTS_ROOT` (default
`/var/aiops/test-reports/<JIRA>/<run-id>/`) so they survive the
nightly worktree GC. The Jira PASS transition is operator-configurable
via `JIRA_TEST_PASS_TRANSITION`. Concurrent Playwright runs serialise
through the existing `withRunLock` mutex pattern using a shared key.

## Problem Statement / Motivation

Today the orchestrator's terminal state is `done`: a PR is opened,
Jira is on Code Review, and a human (often manual QA) runs tests
externally. Two consequences:

1. **Unverified code is declared "done."** The orchestrator has no
   first-party signal whether the agent's diff actually compiles,
   types, or runs in a browser. Failures surface late (manual QA),
   one-by-one, hours after implementation.
2. **Manual QA is the only check.** The merged QA-Fix-Loop
   (`feat/qa-failed-fix-loop`) lets a human re-flow a failed card
   back through brainstorm → … → implement, but it requires a human
   to detect the failure first. Playwright is the obvious automated
   first-pass.

The managed repo (e.g. `BASE_REPO=/var/www/lawrenze.multiportal.io`)
already has Playwright tests on branch `marben-qa-test`. They are not
on aiops's repo — the orchestrator just shells out into the per-task
worktree, which is a checkout off `BASE_REPO`'s HEAD. Once the
managed repo merges Playwright to its main, every task worktree
inherits it for free.

## Proposed Solution

A new lane named `test`, slotted as: `… → implement → test → done`.

**One agent for v1: `test:playwright`** — a `bypassPermissions` agent
whose prompt is mostly "detect Playwright, run it, parse JSON
reporter, write `docs/tests/<JIRA>-test.md` with verdict + failure
summary." Reuses the existing `claude -p` + stream-json + cost-track
+ exit-code-classification harness; we don't write a custom runner.

**Auto-advance is triggered from `implementComplete.ts`** (not from
`spawnAgent.finalize`), because Implement is human-gated by the
Approve & PR / Approve Implementation buttons. After
`implementComplete` writes its final lane state (currently `"done"`),
we change it to write `"test"` and start the `test:playwright` run.
The existing `autoAdvance` map gets `test: null` so terminal
behaviour stays operator-driven (`testComplete.ts` writes
`"done"` on PASS).

**On FAIL the card holds on `test`.** Operator sees a Re-run Tests
button and a Fix from Tests button on the card. Fix from Tests is a
thin wrapper around the existing
`POST /api/tasks/[id]/qa-fix/start` endpoint with a new `source:
"test_failure"` discriminant — it injects the test artifact markdown
as findings, kicks off `brainstorm → plan → review → implement →
test → done` again. `implementComplete` already detects QA-fix-cycles
via `wasQaFixCycleRun`; we add a sibling `wasTestFixCycleRun` that
treats them identically except for the comment template
(`postTestFixComment`).

**Lane chip on the swimlane board** sources `testVerdict` + counts
from the latest test artifact per task (one additional point lookup
in `enrichTask.ts`).

**Persistent test reports** are copied out of the worktree at run
completion to `TEST_REPORTS_ROOT/<JIRA>/<run-id>/`. Linked from the
test artifact markdown. Pruned by a sibling cron job (mirror the
existing `WORKTREE_ARCHIVED_GRACE_DAYS` policy).

**Concurrency** is bounded to one Playwright run at a time per aiops
instance via `withRunLock("test:playwright:global", fn)` — reuses
the existing `chatMutex.ts` primitive, no new code surface.

## Technical Approach

### Architecture

The change crosses 9 layers. Each layer's touchpoint is named here so
the implementer doesn't have to rediscover it during work.

```
┌──────────────────────────────────────────────────────────────────┐
│ DB SCHEMA       server/db/schema.ts                              │
│   tasks.currentLane enum  +  runs.lane enum  +  artifacts.kind   │
│   migration: 0004_<auto>.sql via `pnpm drizzle-kit generate`     │
├──────────────────────────────────────────────────────────────────┤
│ AGENT REGISTRY  server/agents/registry.ts                        │
│   Lane union  +  AGENTS["test:playwright"]                       │
│   defaultAgentForLane("test") → "test:playwright"                │
├──────────────────────────────────────────────────────────────────┤
│ AUTO-ADVANCE    server/worker/autoAdvance.ts                     │
│   NEXT.test = null   (terminal — testComplete writes "done")     │
├──────────────────────────────────────────────────────────────────┤
│ SPAWN HOOK      server/worker/spawnAgent.ts                      │
│   - mutex via withRunLock for lane==="test"                      │
│   - rollback case: lane==="test" + didNotComplete → hold on test │
│     (do NOT roll back to "implement"; the push already landed)   │
│   - on completed + lane==="test" → run testComplete()            │
├──────────────────────────────────────────────────────────────────┤
│ TEST FINALISE   server/git/testComplete.ts            (NEW)      │
│   - parse latest test artifact for verdict + counts              │
│   - copy reports to TEST_REPORTS_ROOT                            │
│   - post Jira comment (pass/fail variant)                        │
│   - on PASS: optional JIRA_TEST_PASS_TRANSITION + lane→done      │
│   - on FAIL: lane stays "test", audit row test.failed            │
├──────────────────────────────────────────────────────────────────┤
│ IMPLEMENT HOOK  server/git/implementComplete.ts                  │
│   change Step 4 lane target: "done" → "test"                     │
│   ALSO start the test:playwright run via startRun(…)             │
├──────────────────────────────────────────────────────────────────┤
│ ARTIFACTS       server/worker/persistArtifacts.ts                │
│   ArtifactKind += "test"                                         │
│   LANE_TO_KIND.test = { kind: "test", dir: "docs/tests" }        │
│   DOWNSTREAM.test = []                                           │
├──────────────────────────────────────────────────────────────────┤
│ FIX FROM TESTS  app/api/tasks/[id]/qa-fix/start/route.ts         │
│   accept currentLane==="test"  +  source: "test_failure"         │
│   inject test artifact markdown as findings                      │
│   server/lib/taskCycle.ts: + isTaskInTestFixCycle helper         │
├──────────────────────────────────────────────────────────────────┤
│ UI              server/lib/enrichTask.ts                         │
│                 components/board/Board.tsx                       │
│                 app/cards/[id]/page.tsx                          │
│                 components/card-detail/{ArtifactPanel,           │
│                   CardMainTabs}.tsx                              │
│   - Task type: + testVerdict, testPassCount, testFailCount       │
│   - lane chip in board                                           │
│   - "Re-run Tests", "Fix from Tests", "Skip Tests" buttons       │
│   - test artifact tab in card detail                             │
└──────────────────────────────────────────────────────────────────┘
```

#### Why auto-advance fires from `implementComplete`, not `spawnAgent.finalize`

Today, `spawnAgent.finalize` (server/worker/spawnAgent.ts:454-470)
records `implement.awaiting_approval` when an Implement run completes
and explicitly leaves the lane on `"implement"`. The lane only moves
to `"done"` when the operator clicks Approve Implementation, which
runs `implementComplete()`. So Implement → Test cannot ride the
existing `autoAdvance` mechanism — `autoAdvance` triggers off
*run completion*, but Test should trigger off *operator approval*.

Solution: at the end of `implementComplete()` Step 4, instead of
`currentLane: "done"`, write `currentLane: "test"` and call
`startRun({ taskId, lane: "test", agentId: "test:playwright",
initiator: { kind: "auto_advance" } })`. The existing autoAdvance
machinery handles nothing here — it's an explicit kickoff inside
the transaction sequence.

`testComplete.ts` is symmetric: on PASS it writes `currentLane: "done"`
inside its own transaction, just as today's `implementComplete` does.

### Implementation Phases

#### Phase 1: Schema + types + plumbing (0.5 day)

Goal: add `"test"` everywhere it needs to exist as a string literal,
without behavioural change. Card lanes can now be put on `"test"`
via direct DB write but no agent yet runs.

Tasks:
- Edit `server/db/schema.ts`:
  - Line 88-95: tasks `currentLane` enum → add `"test"` between
    `"implement"` and `"done"`.
  - Line 140: runs `lane` enum → add `"test"`.
  - Line 211-224: artifacts `kind` enum → add `"test"`.
- Edit `server/agents/registry.ts:10`: `Lane` union → add `"test"`.
- Edit `server/lib/enrichTask.ts:34-42`: `currentLane` cast union →
  add `"test"`.
- Edit `components/board/Board.tsx`: `Task["currentLane"]` union →
  add `"test"`.
- Edit `app/cards/[id]/page.tsx:183`, `components/card-detail/
  ArtifactPanel.tsx:8`, `components/card-detail/CardMainTabs.tsx:14`
  — all the `kind` / lane discriminants get `"test"` added.
- Run `pnpm drizzle-kit generate` to emit
  `server/db/migrations/0004_<auto>.sql`. SQLite text columns have
  no CHECK constraint so the migration is essentially a snapshot
  bump, but check it in — drizzle-kit's strict mode won't run
  without it.
- Manually verify: run `pnpm tsc --noEmit` and the existing
  vitest suite. No tests should break (the lane only exists in
  types; nothing produces it yet).

##### test.ts

```typescript
// tests/laneEnumExtension.test.ts
import { describe, it, expect } from "vitest";
import type { Lane } from "@/server/agents/registry";

describe("Lane enum", () => {
  it("includes test between implement and done", () => {
    const lanes: Lane[] = [
      "brainstorm", "plan", "review", "pr", "implement", "test",
    ];
    expect(lanes).toContain("test");
  });
});
```

#### Phase 2: `test:playwright` agent + spawn hooks (1 day)

Goal: a card whose lane is manually set to `"test"` via SQL spawns
a Playwright run when the operator clicks Run.

Tasks:
- Edit `server/agents/registry.ts`:
  - Add `playwrightTestPrompt(ctx)` builder. Output: instructs Claude
    to (1) verify Playwright is configured, (2) run `pnpm playwright
    install --with-deps` then `pnpm playwright test --reporter=list,
    --reporter=json:test-results.json`, (3) parse the JSON, (4) write
    `docs/tests/<jiraKey>-test.md` with frontmatter `ticket, date,
    status: draft, verdict: PASS|FAIL, passed: N, failed: N` and a
    failure summary section (file, title, error excerpt, link to HTML
    report path), (5) exit non-zero on FAIL.
  - Add `AGENTS["test:playwright"]`:
    - `id: "test:playwright"`, `name: "CE Playwright"`, `lanes: ["test"]`
    - `skillHint: null`, `model: "claude-sonnet-4-6"` (orchestration only)
    - `maxTurns: 30`, `permissionMode: "bypassPermissions"`
    - default cost caps (no override; falls through to global $5/$15)
    - `produces: { kind: "test", dir: "docs/tests" }`
  - `defaultAgentForLane("test") → "test:playwright"` in the switch
    statement at `:902-915`.
- Edit `server/worker/persistArtifacts.ts`:
  - `ArtifactKind` union (lines 14-22): add `"test"`.
  - `LANE_TO_KIND` (26-31): `test: { kind: "test", dir: "docs/tests" }`.
  - `DOWNSTREAM` (35-44): `test: []`.
- Edit `server/worker/autoAdvance.ts`:
  - `NEXT` map: add `test: null` (terminal — testComplete writes done).
  - No change to `implement: null` here yet.
- Edit `server/worker/startRun.ts:114-116`: confirm `lane === "pr"`
  guard does not exclude `"test"`. Currently it doesn't (only blocks
  `"pr"`). No change.
- Edit `server/worker/spawnAgent.ts`:
  - Around the spawn site (line ~55): wrap with `withRunLock(
    "test:playwright:global", () => spawnInner(...))` when the
    agent id is `"test:playwright"`. `withRunLock` is imported from
    `./chatMutex`. (Or add a sibling `testRunMutex.ts` exporting
    `withTestRunLock` that wraps `withRunLock` with a fixed key —
    cleaner and one place to change scope from "global" to
    "per-managed-repo" later.)
  - Lane rollback at line 383-401: add a `lane === "test"` branch.
    On `didNotComplete`, **do NOT** roll back to `"implement"` —
    the implementation is pushed and Jira is on Code Review.
    Instead, leave `currentLane = "test"`, clear `currentRunId`,
    audit `task.test_run_aborted`. Operator can re-run.

Manual verification: SQL-update a test card to
`currentLane = "test"`, click the lane's Run button (Phase 3 wires
this UI; for Phase 2 use the existing API directly via curl), and
confirm the agent runs Playwright in the worktree and writes
`docs/tests/<JIRA>-test.md`.

##### test.ts

```typescript
// tests/playwrightAgent.test.ts
import { describe, it, expect } from "vitest";
import { AGENTS, defaultAgentForLane } from "@/server/agents/registry";

describe("test:playwright agent", () => {
  it("registered and resolves from defaultAgentForLane", () => {
    expect(AGENTS["test:playwright"]).toBeDefined();
    expect(defaultAgentForLane("test")).toBe("test:playwright");
  });

  it("uses bypassPermissions and emits the test artifact kind", () => {
    const a = AGENTS["test:playwright"];
    expect(a.permissionMode).toBe("bypassPermissions");
    expect(a.produces?.kind).toBe("test");
    expect(a.produces?.dir).toBe("docs/tests");
  });
});
```

#### Phase 3: `testComplete.ts` + implement hook + reports persistence (1 day)

Goal: an Implement run that finishes Approve-Implementation now
auto-spawns a Playwright run; on PASS the card moves to `done`; on
FAIL it holds on `test`. Reports survive worktree cleanup.

Tasks:
- New file `server/git/testComplete.ts`. Skeleton mirrors
  `server/git/implementComplete.ts`:
  - Type `TestCompleteResult = { ok, verdict: "pass"|"fail", passed,
    failed, jiraCommentId, transitioned, warnings } | { ok:false,
    failedAt: Step, error }`.
  - `Step = "report_persistence" | "test_comment" |
    "test_pass_transition" | "lane_to_done"`.
  - **Step 1 — copy reports**: read agent output for the path
    (Playwright's default `playwright-report/` under cwd, plus
    `test-results/`). Copy via `fs.cp(src, dst, { recursive: true })`
    to `<TEST_REPORTS_ROOT>/<jiraKey>/<runId>/`. Audit
    `test.reports_persisted` with `{ src, dst, sizeBytes }`.
  - **Step 2 — Jira comment**: ADF builder
    `testCompleteCommentDoc({ verdict, passed, failed, prUrl,
    jiraKey, branch, reportsUrl })` in
    `server/jira/adf.ts` (sibling of `implementCommentDoc`).
    PASS variant: "✅ Playwright passed — N/N tests, branch X."
    FAIL variant: "❌ Playwright failed — N failures. See test
    artifact for details." Audit `jira.test_comment_posted`.
  - **Step 3 — Jira transition** (PASS only): if
    `env.JIRA_TEST_PASS_TRANSITION` is set, call
    `transitionIssueToName(jiraKey, env.JIRA_TEST_PASS_TRANSITION)`.
    Non-fatal on failure; warn-only.
  - **Step 4 — lane move**:
    - PASS: `db.transaction` → `currentLane: "done"` + audit
      `task.test_complete` with `verdict: pass`.
    - FAIL: lane stays `"test"`. Audit `task.test_failed` with
      `{ passed, failed, runId }`. Do NOT clear `currentRunId` —
      the run is the latest; UI uses it to show the FAIL banner.
- Edit `server/git/implementComplete.ts`:
  - Step 4 (lines 358-376) — change `set({ currentLane: "done", … })`
    to `set({ currentLane: "test", … })`.
  - **Critical**: skip this rewrite when in a QA-fix or test-fix
    cycle. Re-flowed cards already pushed once, so they should land
    back at `"done"`, not re-run tests. Use `isTaskInQaFixCycle`
    (already imported at line 244) and `isTaskInTestFixCycle` (added
    in Phase 5 — until then guard with just QA cycle).
  - After lane write, kick off the test run:
    `await startRun({ taskId, lane: "test", agentId:
    "test:playwright", initiator: { kind: "auto_advance" },
    bypassIdempotency: true })`. Wrap in try/catch — if startRun
    fails, audit and return ok with a warning; the operator can
    manually start the test run.
- Edit `server/worker/spawnAgent.ts`:
  - `finalize`'s `status === "completed"` branch (line 419+):
    after `persistArtifactsForRun`, check
    `run?.lane === "test"` and call `testComplete(runId, taskId)`.
    Mirror the `implement` lane's awaiting-approval audit pattern
    but actually invoke the finaliser (no human gate for test).
- Edit `server/lib/config.ts`:
  - Add `TEST_REPORTS_ROOT: z.string().min(1).default("/var/aiops/test-reports")`.
  - Add `JIRA_TEST_PASS_TRANSITION: optionalStr(z.string().min(1))`.
- Edit `server/lib/settingsSchema.ts`:
  - In `paths` section (line 187-216): add `TEST_REPORTS_ROOT`
    field below `WORKTREE_ROOT`.
  - In `jira` section (where `JIRA_REVIEW_STATUS` lives near 180):
    add `JIRA_TEST_PASS_TRANSITION` with `kind: "text"`,
    placeholder example, optional.
- Edit `server/cron/nightly.ts`: add a sibling cron pass that
  prunes `<TEST_REPORTS_ROOT>/<jiraKey>/<runId>/` directories where
  the `runId`'s `runs.createdAt` is older than
  `MESSAGE_RETENTION_DAYS` (or a new `TEST_REPORTS_RETENTION_DAYS`
  default 30). Use the existing pattern at line 21-44.

##### testComplete.test.ts

```typescript
// tests/testComplete.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/server/db/client";
import { testComplete } from "@/server/git/testComplete";
import { tasks, runs, artifacts } from "@/server/db/schema";

vi.mock("@/server/jira/client", () => ({
  postComment: vi.fn().mockResolvedValue("comment-1"),
  transitionIssueToName: vi.fn().mockResolvedValue({ id: "t1", name: "QA Passed" }),
}));

describe("testComplete", () => {
  beforeEach(() => {
    // truncate tasks, runs, artifacts, audit_log
  });

  it("on PASS: moves lane to done + posts pass comment + transitions when env set", async () => {
    // seed task on lane=test, run=completed, artifact verdict=PASS
    const res = await testComplete("run-1", "task-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict).toBe("pass");
    const t = db.select().from(tasks).where(...).get();
    expect(t.currentLane).toBe("done");
  });

  it("on FAIL: lane stays test + posts fail comment + skips transition", async () => {
    // seed task on lane=test, run=failed (or completed-with-FAIL-verdict),
    // artifact verdict=FAIL
    const res = await testComplete("run-2", "task-2");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict).toBe("fail");
    const t = db.select().from(tasks).where(...).get();
    expect(t.currentLane).toBe("test");
  });

  it("copies reports to TEST_REPORTS_ROOT/<JIRA>/<runId>/", async () => {
    // mock fs.cp; assert called with correct src/dst
  });
});
```

#### Phase 4: UI surfacing — board chip + card detail tab + buttons (1 day)

Goal: operator sees test status without leaving the swimlane board;
clicks Re-run Tests / Skip Tests / Fix from Tests directly.

Tasks:
- Edit `server/lib/enrichTask.ts`:
  - Add a query for the latest test artifact per task:
    `SELECT json_extract(frontmatter, '$.verdict') AS verdict,
    json_extract(frontmatter, '$.passed') AS passed,
    json_extract(frontmatter, '$.failed') AS failed
    FROM artifacts WHERE task_id=? AND kind='test'
    ORDER BY created_at DESC LIMIT 1`. (Or parse from markdown
    frontmatter at ingest time and store as columns.) Append:
    `testVerdict?: "pass" | "fail" | null,
     testPassCount?: number, testFailCount?: number`.
- Edit `components/board/Board.tsx`:
  - Extend `Task` type with the three new fields.
  - In the lane chip render path: when a card's
    `currentLane === "test"`, show a small badge with
    `testFailCount` failures (red) or `testPassCount/total` (green).
    Match existing run-cost chip styling.
- Edit `app/cards/[id]/page.tsx`:
  - Add `"test"` to the lane discriminants at lines 183, 248, 380.
  - On the `test` lane, render three buttons: `<RerunTestsButton/>`,
    `<FixFromTestsButton/>`, `<SkipTestsButton/>`. The first reuses
    the existing per-lane Run button (`startRun(lane: "test", agentId:
    "test:playwright")`). The second is a new modal mirroring
    `FixFromQaButton` shape but pre-filling findings from the test
    artifact (no operator selection needed). The third hits a new
    endpoint `POST /api/tasks/[id]/skip-tests` that audits
    `test.skipped` and moves lane to `"done"`.
- Edit `components/card-detail/CardMainTabs.tsx`:
  - Lines 14-39 + 68-77 + 78+ — add `"test"` to `CardArtifact["kind"]`
    union, `ARTIFACT_KINDS` array, `KIND_ORDER`, `KIND_LABEL` map
    ("Tests"). Tab list auto-renders.
- Edit `components/card-detail/ArtifactPanel.tsx`:
  - Line 8 — add `"test"` to the kind union. Render the test
    artifact via the existing markdown viewer; no special component
    for v1 (the markdown already contains a failure summary section).
- New `components/card-detail/SkipTestsButton.tsx`,
  `RerunTestsButton.tsx`, `FixFromTestsButton.tsx`. Style from
  existing `FixFromQaButton.tsx`.
- New `app/api/tasks/[id]/skip-tests/route.ts` — POST. Auth check
  matches existing per-task POST handlers (operator-only). Validates
  `currentLane === "test"`, audits `test.skipped` with operator id
  + reason, transitions lane to `"done"`, posts a "Tests skipped
  by operator" Jira comment. Returns 200.

##### Skip-tests test.ts

```typescript
// tests/skipTestsRoute.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "@/app/api/tasks/[id]/skip-tests/route";

describe("POST /api/tasks/[id]/skip-tests", () => {
  it("rejects when currentLane !== 'test'", async () => {
    // seed task with currentLane='implement'
    const res = await POST(new Request("..."), { params: { id: "t1" } });
    expect(res.status).toBe(409);
  });

  it("on success: lane→done + audits + posts Jira comment", async () => {
    // seed task with currentLane='test'
    const res = await POST(...);
    expect(res.status).toBe(200);
    // assert lane==='done', audit row exists, Jira comment posted
  });
});
```

#### Phase 5: Fix from Tests — QA-Fix-Loop reuse (0.5 day)

Goal: a failing test triggers the same brainstorm → … → implement
re-flow that QA failures already do, with no parallel cycle helper.

Tasks:
- Edit `app/api/tasks/[id]/qa-fix/start/route.ts`:
  - Line 54 — relax lane check: accept `currentLane === "done"`
    (existing) OR `currentLane === "test"` (new).
  - Add `source: "test_failure"` discriminant in request body.
    Schema: `{ qaCommentIds?: string[] } | { source:
    "test_failure" }` (one or the other, never both).
  - When `source === "test_failure"`: load the latest test
    artifact for this task, build synthetic findings as a single
    "comment" — `{ author: "Playwright", created: <runEndedAt>,
    body: <test artifact failure summary section> }`. Pass these
    to `buildQaFixBrainstormPrompt(promptContext, findings, cycleN)`
    just like operator-selected comments today.
  - Audit row payload: `{ qaFixCycle: true, source: "test_failure",
    testRunId }` instead of `qaFixCycle + qaCommentIds`.
- Edit `server/lib/taskCycle.ts`:
  - Add `wasTestFixCycleRun(runId): boolean` mirroring
    `wasQaFixCycleRun` (line 134-153) but checking
    `json_extract(payload, '$.source') = 'test_failure'`.
  - Add `isTaskInTestFixCycle(taskId): boolean` mirroring
    `isTaskInQaFixCycle` (line 166-199).
- Edit `server/git/implementComplete.ts`:
  - Step 4 lane-write guard: skip the `"test"` rewrite when
    `isTaskInTestFixCycle(taskId)` returns true — the test-fix
    cycle should land on `"done"` (skip re-running tests) the
    same way QA-fix cycles do. (Future refinement: re-run tests
    on test-fix cycles too — open question for v2.)
  - Step 2 comment branch (line 244-294): add a third branch —
    `isTaskInTestFixCycle` → `postTestFixComment` (new module
    mirroring `qaFixComment.ts`).
- New `server/jira/testFixComment.ts` — clone of `qaFixComment.ts`
  with `action: "jira.test_fix_comment_*"` and a "Fix from Tests
  cycle N — pushed" comment template.

##### Test-fix cycle test.ts

```typescript
// tests/testFixCycle.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  isTaskInTestFixCycle,
  wasTestFixCycleRun,
} from "@/server/lib/taskCycle";
import { POST as qaFixStartRoute } from "@/app/api/tasks/[id]/qa-fix/start/route";

describe("test-fix cycle helpers", () => {
  beforeEach(() => { /* truncate */ });

  it("isTaskInTestFixCycle is true after a source:test_failure run.started_request", () => {
    // seed audit row run.started_request with payload.source='test_failure'
    expect(isTaskInTestFixCycle("task-1")).toBe(true);
  });

  it("qa-fix/start with source=test_failure injects test artifact as findings", async () => {
    // seed task lane=test + a test artifact with a failure section
    const res = await qaFixStartRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ source: "test_failure" }),
      }),
      { params: { id: "task-1" } },
    );
    expect(res.status).toBe(200);
    // assert audit run.started_request payload contains source=test_failure
  });
});
```

#### Phase 6: Manual verification against `marben-qa-test` (0.5 day)

Goal: dogfood the new lane end-to-end against the real Playwright
suite on the managed repo's `marben-qa-test` branch, before opening
the PR.

This is the answer to the user's second question — how to test the
current aiops branch with the other (Playwright) branch.

Steps:

1. In a separate terminal in the managed repo
   (`/var/www/lawrenze.multiportal.io` or wherever `BASE_REPO`
   points):
   ```
   cd $BASE_REPO
   git fetch origin
   git checkout marben-qa-test
   ```
   This puts Playwright in every new per-task worktree because the
   worktrees branch off `BASE_REPO`'s currently-checked-out HEAD.
2. Sanity check:
   ```
   git -C $BASE_REPO log --oneline -5 marben-qa-test
   test -f $BASE_REPO/playwright.config.ts && echo "playwright OK"
   ```
3. In aiops (`feat/implementation-handoff-improvements` + this
   plan's changes):
   ```
   pnpm install
   pnpm drizzle-kit migrate    # apply 0004_*.sql
   pnpm dev
   ```
4. Take a real or seeded Jira ticket through the full flow:
   `brainstorm → plan → review → pr → implement` (Approve & PR,
   Approve Implementation). Confirm the card auto-advances to
   `test` and the Playwright run executes. Verify:
   - Reports copied to `/var/aiops/test-reports/<JIRA>/<runId>/`.
   - Test artifact at `docs/tests/<JIRA>-test.md` with verdict.
   - On simulated PASS: card lands on `done`, Jira gets a comment.
   - On simulated FAIL (introduce a failing assertion): card holds
     on `test`, Re-run + Fix from Tests + Skip buttons render.
   - Click Fix from Tests → confirm new brainstorm/plan/review/
     implement runs fire and findings include the test artifact's
     failure summary.
5. **Alternative if you don't want to flip `BASE_REPO`'s default
   branch**: `git -C $BASE_REPO worktree add /tmp/marben-tests
   marben-qa-test` then point aiops's `BASE_REPO` at
   `/tmp/marben-tests` via `.env.local`. Reverse afterward.

This is dev/integration guidance for the implementer; not feature
scope. After v1 ships, the plan is to merge `marben-qa-test` into
the managed repo's main so step 1 becomes unnecessary.

## Alternative Approaches Considered

**(A) New runner outside the Claude harness.** Spawn `pnpm playwright
test` directly from a Node child_process in `testComplete.ts` (no
Claude wrapping the bash). Pros: lower per-run cost, simpler
prompt. Cons: loses the existing observability stack — stream-json,
cost meter, runs row, audit log. Would need a parallel pipeline for
test runs. **Rejected** because the observability cost outweighs the
~$0.50 per-run Claude tax.

**(B) Test lane after `done`, not before.** Run Playwright after the
PR is opened and Jira is on Code Review. Pros: aligns with how QA
typically runs (post-merge or post-PR). Cons: makes "done" mean
"shipped without verification" — the exact problem we're trying to
solve. **Rejected.**

**(C) Skip the human approval at `implement`.** Auto-advance from
implement run completion → test → done without the Approve
Implementation button. Pros: fully automated path. Cons: removes the
human gate that the existing flow deliberately introduced for diff
review. **Rejected.** The Approve Implementation gate stays; test
fires after it.

**(D) Per-managed-repo mutex key instead of global.** Key the test
mutex on `BASE_REPO` so multi-tenant deployments could parallelise
across repos. Pros: future-proofing. Cons: aiops is single-tenant per
instance today (one `BASE_REPO`). YAGNI. **Rejected for v1**, easy
to add later by changing the mutex key.

**(E) `qa_failed` as a new run status.** Brainstorm assumed this
existed. Research shows `decideExitStatus` returns `"failed"` on
non-zero exit; there is no `qa_failed`. **Adopted: use `"failed"`**
and gate the test-fix-loop on `currentLane === "test"` + the latest
test artifact's verdict, not on a new run-status enum value.

## System-Wide Impact

### Interaction Graph

When `implementComplete` finishes:
1. Writes `currentLane: "test"` + `task.implementation_complete` audit.
2. Calls `startRun(lane: "test", agentId: "test:playwright")`.
3. `startRun` inserts `runs` row, sets `tasks.currentRunId`, builds
   prompt via `playwrightTestPrompt(ctx)`, calls `spawnAgent(...)`.
4. `spawnAgent` acquires `withRunLock("test:playwright:global")`,
   spawns `claude -p` with bypassPermissions, streams output,
   writes messages.
5. Claude runs `pnpm playwright test`, parses results, writes
   `docs/tests/<JIRA>-test.md`, exits 0 (PASS) or non-zero (FAIL).
6. `spawnAgent.finalize` runs:
   - Updates `runs.status` via `decideExitStatus`.
   - Persists artifact via `persistArtifactsForRun`.
   - Detects lane === "test" → calls `testComplete(runId, taskId)`.
7. `testComplete`:
   - Copies reports to `TEST_REPORTS_ROOT/<JIRA>/<runId>/`.
   - Posts Jira comment (pass/fail variant).
   - On PASS + `JIRA_TEST_PASS_TRANSITION` set: transitions ticket.
   - On PASS: writes `currentLane: "done"` + audit
     `task.test_complete`.
   - On FAIL: leaves lane = "test" + audit `task.test_failed`.
8. UI polls `/api/tasks/[id]` → operator sees status. On FAIL,
   Re-run / Fix from Tests / Skip buttons render.

### Error & Failure Propagation

- **Playwright CLI fails to start (missing browsers, etc.)**: agent
  catches, writes artifact with `verdict: FAIL` + error message,
  exits non-zero → `runs.status = "failed"` → testComplete fires
  with verdict=fail (read from artifact). Operator sees FAIL banner;
  Re-run is the path.
- **Claude session hits maxTurns**: `decideExitStatus` returns
  `"failed"`. Lane rollback (Phase 2 change) holds card on `"test"`.
  Operator can re-run.
- **Cost cap trips**: `decideExitStatus` returns `"cost_killed"`.
  Lane holds on test. Operator can re-run after raising cap.
- **Operator hits Stop**: `decideExitStatus` returns `"stopped"`.
  Lane holds on test.
- **`testComplete` itself throws** (e.g. fs.cp fails on disk full):
  finalize catches, audits, leaves lane on `"test"` with the run
  marked `completed`. Operator sees a banner explaining the
  finalisation failure.
- **`startRun` fails inside `implementComplete`**: existing
  implementation comment + Jira transition still happened; we audit
  `test.start_failed` and return `ok: true` with a warning. Operator
  manually starts the test run from the card.
- **Jira PASS transition fails**: warn-only. PR comment + lane move
  still happen. Mirrors existing transition fallback at
  `implementComplete.ts:340-348`.

### State Lifecycle Risks

- **Worktree GC vs. test reports**: solved — reports live outside
  worktree at `TEST_REPORTS_ROOT`. New cron pass enforces report
  retention.
- **Test run abort mid-execution**: lane stays on `"test"` (Phase 2
  rollback change). The Playwright process running inside the
  worktree may leave a half-written `playwright-report/` — the
  next test run overwrites it.
- **Mutex starvation**: serial Playwright runs. With low ticket
  volume (board-typical), this is fine. If volume rises, change
  the mutex key from a global to per-repo.
- **Re-flow loops**: a stuck Fix from Tests cycle could loop
  forever. Existing cycle helpers and `qaFixCycleCount` already
  enforce a soft limit on the operator's UX (counter chip); add a
  parallel test-fix-cycle counter for visibility. Hard cap is
  out of scope for v1.

### API Surface Parity

- New POST endpoint `/api/tasks/[id]/skip-tests` follows the
  per-task POST convention used by `/qa-fix/start`,
  `/approve-implementation`, etc. CSRF + auth same shape.
- `/api/tasks/[id]/qa-fix/start` accepts the new `source:
  "test_failure"` discriminant. Backwards-compat: existing callers
  pass `qaCommentIds`, which still works.

### Integration Test Scenarios

1. Full implement → test → done on PASS path: assert all 4 audit
   actions land in order (`task.implementation_complete`,
   `run.started_request{lane:test}`, `task.test_complete`).
2. Implement → test → FAIL hold: assert lane stays "test", run
   status is "failed", Jira comment posted with FAIL variant.
3. FAIL → Fix from Tests → reflow: assert new brainstorm/plan/
   review/implement runs fire with `source: "test_failure"` audit
   payload, and `implementComplete` lands on "done" (skipping the
   re-test) inside a test-fix cycle.
4. Concurrent Implement-Approve on two tasks: assert their
   subsequent test runs serialise via the mutex (one starts after
   the other's `runs.endedAt`).
5. Skip Tests → done: assert lane moves to "done" with audit
   `test.skipped`, no test artifact required.

## Acceptance Criteria

### Functional Requirements

- [ ] `Lane` union, schema enums, and UI discriminants include
      `"test"`. `pnpm tsc --noEmit` clean.
- [ ] Drizzle migration `0004_*.sql` checked in.
- [ ] `test:playwright` agent registered and resolves via
      `defaultAgentForLane("test")`.
- [ ] `implementComplete` moves the lane to `"test"` and starts the
      Playwright run (cycle-1 path). Skips this on QA-fix and
      test-fix cycles.
- [ ] `testComplete` copies reports to `TEST_REPORTS_ROOT`, posts a
      Jira comment, optionally transitions, and writes
      `currentLane: "done"` on PASS.
- [ ] On test FAIL, lane stays `"test"`. Operator sees Re-run Tests,
      Fix from Tests, and Skip Tests buttons.
- [ ] Fix from Tests reuses `/qa-fix/start` with `source:
      "test_failure"` and pre-filled findings from the test
      artifact.
- [ ] Skip Tests moves lane to `"done"` with `test.skipped` audit
      row and a Jira comment.
- [ ] Swimlane board chip shows pass/fail count for cards on
      `"test"`.
- [ ] Concurrent test runs serialise through `withRunLock`.

### Non-Functional Requirements

- [ ] No N+1 regression on the swimlane board (one extra point
      lookup per task; verify with `pnpm dev` + a 50-card seed).
- [ ] Test reports retention drops directories older than
      `TEST_REPORTS_RETENTION_DAYS` (default 30) via nightly cron.
- [ ] Mutex prevents two simultaneous Playwright runs from the
      same aiops instance.
- [ ] `bypassPermissions` agent runs `pnpm playwright install
      --with-deps` and `pnpm playwright test` without prompting.

### Quality Gates

- [ ] Unit tests for: lane enum, agent registration, exit-status
      classification (regression), test-fix cycle helpers, the
      skip-tests route, and `testComplete` (PASS, FAIL, error
      paths).
- [ ] Manual end-to-end run against `marben-qa-test` per Phase 6.
- [ ] `docs/tests/<JIRA>-test.md` artifact renders correctly in
      the card detail tab.

## Success Metrics

- **Catch rate**: % of cards that hit `"test"` and surface a
  Playwright failure that would have otherwise gone to manual QA.
  Target after 2 weeks of usage: >0 (any catch is signal that the
  lane is doing work).
- **False-positive rate**: % of test FAILs that the operator
  declares "not really a failure" (uses Skip Tests). Target <20% —
  higher means Playwright is flaky and needs project-side fixing.
- **Mean time on `"test"` lane**: should be on the order of a
  Playwright suite's runtime (a few minutes). >30m means the agent
  is misbehaving (loop, infinite turns).

## Dependencies & Prerequisites

- Managed repo must have Playwright configured with a `webServer`
  block in `playwright.config.*` so the agent doesn't have to boot
  the app. Documented as a managed-repo requirement in the wizard's
  Paths section.
- `pnpm` available on PATH for the agent subprocess (already
  required for `ce:work`).
- Disk for `TEST_REPORTS_ROOT` (default `/var/aiops/test-reports`,
  configurable via wizard).
- `marben-qa-test` branch on the managed repo for dogfooding (Phase
  6); not a permanent dependency once it merges to main.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Playwright flakes flood the test-fix loop | M | M | Skip Tests button + visible cycle-counter chip; document expected reliability targets in setup wizard |
| `pnpm playwright install` is slow on first run per worktree | H | L | Acceptable. Browsers cache to `~/.cache/ms-playwright` (HOME is in env allowlist), so subsequent runs are fast |
| Mutex causes unbounded queue under bursty load | L | M | Single-instance, low ticket volume per aiops install. Mitigated by per-repo mutex key when needed (out of v1 scope) |
| `testComplete` fs.cp fails (disk full / perms) | L | M | Try/catch + warn; runs.status stays `completed`, lane stays `test`. Operator can re-run or Skip |
| Migration adds enum value but downgrade path doesn't drop it | L | L | SQLite text columns have no constraint; rollback only requires the typescript change. Document in plan's Migration Notes |
| Existing tests break on Lane union expansion | L | L | TypeScript will surface anything missed. Phase 1 adds the union before any code uses it |

## Resource Requirements

- 1 engineer × 3.5 days = 28 hours (rough order-of-magnitude).
- No new infra (single SQLite, single Node process).
- Disk: ~50MB per Playwright run × retention window. With 30 days
  retention and 5 runs/day, ~7.5GB at steady state. Document in
  setup wizard.
- No new external dependencies in `package.json`.

## Future Considerations

- **More test agents**: `test:vitest`, `test:cypress`, `test:custom`
  on the same lane. Operator picks default in agent overrides.
- **Auto-retry on flake**: detect a previously-passing test that
  failed, re-run before declaring FAIL. Needs historical signal.
- **Per-repo mutex**: scope concurrency to managed repo when aiops
  becomes multi-tenant.
- **Auto-Fix from Tests**: skip the operator click; feed failures
  straight into a new brainstorm cycle. Requires confidence in the
  signal (low false-positive rate after 2 weeks of manual flow).
- **Test-result trends**: dashboard tile showing PASS rate over
  time. Builds on the existing `dashboardQueries.ts` patterns.
- **Re-run tests on test-fix cycle**: today the test-fix cycle
  short-circuits back to `"done"` (matching QA-fix behaviour). A
  future enhancement could re-run the test lane after a test-fix
  to confirm the fix actually fixed it.

## Documentation Plan

- Update `README.md` "Setup wizard" section (currently lines
  181-194) with a paragraph on the test lane and the `BASE_REPO`
  Playwright requirement.
- Add a "Test reports" subsection under `## Architecture` in the
  README explaining `TEST_REPORTS_ROOT`, retention, and how to
  surface them.
- Setup wizard step copy (`server/lib/settingsSchema.ts` field
  descriptions) carries the operator-facing explanation —
  consistent with how the existing flow documents config.
- After v1 ships: write a `docs/solutions/2026-MM-DD-test-lane-
  gotchas.md` capturing anything the rollout surfaces. The
  `docs/solutions/` directory does not currently exist; this would
  be the first entry.

## Sources & References

### Origin

- **Brainstorm document:**
  [docs/brainstorms/2026-05-08-post-implement-test-lane-brainstorm.md](../brainstorms/2026-05-08-post-implement-test-lane-brainstorm.md) —
  decisions carried forward:
  1. New lane `test` between `implement` and `done` (not after
     `done`).
  2. Reuse Claude+bash harness (`test:playwright` agent) over a
     parallel runner.
  3. Reports persist to `TEST_REPORTS_ROOT`.
  4. PASS auto-advances to `done`; FAIL holds on `test` and feeds
     QA-Fix-Loop with `source: "test_failure"`.
  5. In-memory mutex on `withRunLock` global key.
  6. Lane chip with pass/fail count on the swimlane board.

### Internal References

- Lane enum: `server/db/schema.ts:88-95` (tasks),
  `server/db/schema.ts:140` (runs), `server/db/schema.ts:211-224`
  (artifacts).
- Auto-advance map: `server/worker/autoAdvance.ts:9-17`.
- Implement finalisation template:
  `server/git/implementComplete.ts:48-393` (mirror for
  `testComplete.ts`).
- Spawn + finalize + lane rollback:
  `server/worker/spawnAgent.ts:316,383-401,419-470`.
- Exit-status classifier: `server/worker/exitStatus.ts:27-38`.
  Note: there is no `qa_failed` enum value; `"failed"` is the
  status for non-zero Playwright exits.
- Mutex pattern: `server/worker/chatMutex.ts:20-38`
  (`withRunLock`).
- Persist artifacts: `server/worker/persistArtifacts.ts:14-44`
  (`ArtifactKind`, `LANE_TO_KIND`, `DOWNSTREAM`).
- Agent registry: `server/agents/registry.ts:10`
  (`Lane` union), `:711-798` (existing AGENTS map),
  `:902-915` (`defaultAgentForLane`).
- QA-Fix-Loop entry: `app/api/tasks/[id]/qa-fix/start/route.ts:18-102`.
  Cycle helpers: `server/lib/taskCycle.ts:134-199`.
- Settings schema (where new env vars register):
  `server/lib/settingsSchema.ts:180-216`. Config validator:
  `server/lib/config.ts:64-65`.
- Board enrichment for lane chip:
  `server/lib/enrichTask.ts:8-57`. Board renderer:
  `components/board/Board.tsx`.
- Card detail UI: `app/cards/[id]/page.tsx:183,243-256,348,
  375-381`. Tab structure: `components/card-detail/CardMainTabs.tsx:14-77`.
  Artifact panel: `components/card-detail/ArtifactPanel.tsx:8`.
- Worktree GC pattern (template for test-reports cron):
  `server/cron/nightly.ts:21-44`.
- Tests pattern (vitest + in-memory SQLite):
  `tests/taskCycle.test.ts:1-50`,
  `tests/decideExitStatus.test.ts`.

### External References

- Playwright JSON reporter:
  https://playwright.dev/docs/test-reporters#json-reporter
- Playwright `webServer` config:
  https://playwright.dev/docs/test-webserver
- Drizzle SQLite text-enum columns:
  https://orm.drizzle.team/docs/column-types/sqlite#text

### Related Work

- Predecessor brainstorm: `docs/brainstorms/2026-04-30-qa-failed-fix-loop-brainstorm.md`
  (the QA-Fix-Loop this plan reuses for test-fix cycles).
- Current branch context: `feat/implementation-handoff-improvements`
  — handoff PR description + Jira comment renderers from
  `server/jira/shipNote.ts` are unchanged here; testComplete posts
  its own ADF comment.
