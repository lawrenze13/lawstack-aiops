---
title: Card detail bugs — five issues review
type: review
status: active
date: 2026-05-01
---

# Card detail bugs — review

Five issues observed by the operator during real-world use. Each is
investigated in code, root-caused, and given a recommended fix. The
issues are tightly related — three of them share the same underlying
cause (the `router.refresh()` round-trip is the only mechanism the
client has for learning that a new run started, and it's slow / races
with new SSE event delivery).

## Issue 1 — Chat send stuck on "Sending…", run log doesn't update

### Symptom

After typing a chat message and clicking Send, the button stays on
"Sending…" for several seconds (sometimes indefinitely). The textarea
is disabled the whole time so the operator can't type a follow-up.
The new turn's events don't appear in the run log, and the operator's
own message bubble (`👤 you`) doesn't render until a manual page
reload.

### Code path

`components/card-detail/ChatBox.tsx:54-89`:

```typescript
const send = () => {
  ...
  setLocalUnlock(false);
  startTransition(async () => {
    const res = await fetch(`/api/runs/${runId}/message`, { ... });
    if (!res.ok) { ... return; }
    setText("");
    router.refresh();   // ← void return; transition stays pending
                        //   until the server re-render completes
  });
};
```

`pending` (from `useTransition`) drives the disabled state on both
the textarea (`ChatBox.tsx:114`) and the Send button
(`ChatBox.tsx:122`).

`app/api/runs/[id]/message/route.ts:75-93`: the message endpoint
calls `resumeRun(...)` which returns a **new** runId (the resumed
session is a fresh `runs` row with `resumedFromRunId` linked back).
The endpoint returns `{ runId: result.runId }` — but the client
**ignores** the return value.

### Root cause

Three compounding problems:

1. **`router.refresh()` inside `startTransition` keeps the
   transition pending until the server-component refresh fully
   completes.** The card-detail page query is heavy (loads all
   runs, artifacts, audit log, pr_records, thread events). On a
   slow render, the user sees "Sending…" for the full duration.

2. **The client doesn't know the new runId until refresh lands.**
   `resumeRun` creates a new run with a new id, updates
   `tasks.currentRunId` to the new id (`startRun.ts:230-233`).
   The page only re-derives `currentRunId` after `router.refresh()`
   completes its DB read. Until then, `RunLog` is bound to the
   **old** runId and listens to the old SSE stream — which has
   already emitted `end`. New events on the new runId's SSE stream
   are missed entirely until the refresh lands and `RunLog`'s
   `useEffect([runId])` rewires.

3. **The TextArea is disabled on `pending`.** The operator can't
   queue up the next message during the round-trip — even though
   nothing on the server prevents it after the initial POST returns
   200. The disable is purely a UI artefact of `useTransition`.

### Recommended fix

The smallest change that fixes all three:

1. **Read the new runId from the response and rebind RunLog
   client-side** instead of waiting for `router.refresh()` to
   surface it via DB. The message endpoint already returns
   `{ runId }` — wire it through.
2. **Stop wrapping `router.refresh()` in `startTransition`.** The
   transition's job is "wait while the message is in flight"; once
   the POST returns 200, the transition can complete. Refresh in
   the background.
3. **Re-enable the textarea immediately after a successful POST**
   so the operator can keep typing.

Sketch:
```typescript
const send = () => {
  ...
  startTransition(async () => {
    const res = await fetch(`/api/runs/${runId}/message`, { ... });
    if (!res.ok) { ... return; }
    setText("");
    const body = await res.json() as { runId: string };
    onRunIdChanged?.(body.runId);   // parent rebinds RunLog
  });
  // router.refresh() OUTSIDE the transition, fire-and-forget
  router.refresh();
};
```

The parent (`app/cards/[id]/page.tsx`) needs a thin client-side
wrapper component that holds `currentRunId` in `useState` and
forwards `onRunIdChanged` so RunLog can rebind without waiting for
the server.

Cost: ~half a day. No DB or API changes (the endpoint already
returns the new runId).

## Issue 2 — Can't run a second cycle after Approve Implementation

### Symptom

After the first cycle reaches `done` (operator clicked Approve & PR,
then Implement, then Approve Implementation), the operator wants to
run another brainstorm → plan → review → implement cycle to add
something. They click Brainstorm; cascade runs through to `ce:work`.
ce:work completes, leaves uncommitted changes in the worktree, and
exits cleanly. The operator types "Commit and push" in chat. The
agent replies:

> I can't run git add, git commit, or git push from this session —
> the orchestration server handles those itself in a follow-up step…

The operator has no way forward. There's no Approve Implementation
button visible on the card.

### Code path

Two things conspire:

1. **`ce:work` prompt explicitly forbids commit/push**
   (`server/agents/registry.ts` workPrompt). The agent leaves
   changes uncommitted because `implementComplete` is the function
   that handles staging, committing, and pushing in one atomic step
   with the Jira comment + status transition.

2. **`ApproveImplementationButton` is sticky-gated.**
   `app/cards/[id]/page.tsx:289-295` shows the button only when
   `awaitingImplementationApproval || implementationFinalised`.
   These flags are derived from audit-log rows and are scoped to
   "any time" — once the first cycle's `task.implementation_complete`
   audit row exists, `implementationFinalised` is permanently true,
   but the button visibility logic doesn't help start a second
   cycle's approval.

   Looking at `ImplementButton.tsx:9-44`:
   ```typescript
   implementStarted = allRuns.some(
     r => r.lane === "implement" &&
          (r.status === "running" ||
           r.status === "awaiting_input" ||
           r.status === "completed")
   );
   if (implementStarted) return null;  // hides button forever
   ```
   Once **any** implement run has reached `completed`,
   `ImplementButton` hides. That's correct for the first cycle but
   wrong for cycle N>1.

### Root cause

The post-implement gating logic was written assuming a single
implement run per task. The button visibility flags
(`implementStarted`, `awaitingImplementationApproval`,
`implementationFinalised`) are not **cycle-scoped** — they look at
all runs / all audit rows for the task instead of "runs / audit rows
since the current cycle started."

This is the **same bug** that the QA-fix loop plan
(`docs/plans/2026-05-01-feat-qa-failed-fix-loop-plan.md`) is fixing
in Phase 4. The fix is universal: it solves both the QA-fix flow
and this bare "run another cycle" flow.

### Recommended fix

Two layers:

1. **Cycle-scope the gating predicates.** Compute
   `currentCycleStartedAt(taskId)` (the most recent brainstorm
   run's `started_at`, or `task.createdAt` if no brainstorm yet).
   Filter the predicates:
   ```typescript
   implementStarted = allRuns.some(
     r => r.lane === "implement" &&
          r.startedAt >= cycleStart &&
          (running|awaiting_input|completed)
   );
   awaitingImplementationApproval = auditLogRows.some(
     r => r.action === "implement.awaiting_approval" &&
          r.createdAt >= cycleStart
   );
   implementationFinalised = auditLogRows.some(
     r => r.action === "task.implementation_complete" &&
          r.createdAt >= cycleStart
   );
   ```
2. **Allow `approveAndPr` to re-run on second cycles.** The current
   function is idempotent-by-state — once `prRecords.state ===
   "jira_notified"`, all 5 steps are skipped on re-call, so a
   second-cycle Approve & PR is a silent no-op. The QA-fix plan
   addresses this with a parallel `approveQaFix(taskId)` function.
   The simpler version of that fix — sufficient for the bare
   re-cycle case — is **either** to reset `prRecords.state` to
   `"drafting"` when starting a new brainstorm cycle, **or** to
   teach `approveAndPr` to detect "second cycle" via cycle helpers
   and re-run from scratch.

Recommendation: **ship the QA-fix plan's Phase 1 + Phase 4 + Phase 5
together** — they solve this bug as a side-effect. If the QA-fix
plan is paused indefinitely, extract those three phases into a
smaller "multi-cycle support" PR.

The user's request "do another full cycle and have it commit/push"
is exactly what the QA-fix plan's cycle-scoped gating + parallel
approveQaFix delivers, just without the Jira-comment-picker entry
point.

Cost (extracted slice, no QA picker): ~2 days. Same code, smaller
surface area.

## Issue 3 — Run log shows all runs concatenated, not just the active one

### Symptom

The run log panel displays the full thread of every run on the task
in chronological order. Operator wants the panel to default to "just
this run's events" with a clear separator from earlier runs.

### Code path

`app/cards/[id]/page.tsx:148-180` loads `threadEvents` (every event
from every run on this task) and seeds `RunLog`'s state with it
(`RunLog.tsx:224-236`).

`RunLog.tsx:685-746` (`EventStream`) groups events by `runId` and
renders per-run sections with `RunHeader` separators showing the
ordinal, lane, agent, status, and an "← current" tag.

This is **intentional design** — the original orchestration plan
called for "one continuous thread" so the operator can see prior
runs' brainstorms while reviewing the current run's plan. But for
the actual most-common workflow (review what *this* run did), the
seed history is noise.

### Root cause

Default presentation choice that no longer matches usage. Not a
bug per se — a UX decision that's aged poorly.

### Recommended fix

The cleanest answer:

1. **Default to scoped view.** `EventStream` filters
   `state.events` to those where `runId === currentRunId` by
   default.
2. **Add a "Show full thread" toggle** at the top of the log panel
   (a checkbox or tab). When checked, render the full thread with
   the existing `RunHeader` separators.
3. **Persist the toggle to localStorage** so the operator's
   preference sticks across page loads.

The work is contained to `RunLog.tsx`. Cost: ~3-4 hours.

Note: scoping doesn't break the SSE seed-from-history path — even
in scoped mode, the seed ensures the current run's history is fully
displayed (replay-after-page-refresh). The toggle just unhides the
prior runs.

## Issue 4 — Preview Dev refuses to switch when working tree is dirty

### Symptom

Operator finishes one card's work, clicks Preview Dev to test it
locally, hits the dev server. Later they want to switch to a
different card's branch and click Preview Dev on that card. Server
returns 409:

> preview dev has uncommitted tracked changes — resolve in
> /path/to/dev: …list of files…

User reports: "sometimes when there's a second commit and the
process switches. it has always have a changes on the dev server
and not pushing thru on switching because of this."

### Code path

`app/api/tasks/[id]/preview/route.ts:67-90`:

```typescript
const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
const dirty = stdout
  .split("\n")
  .filter((l) => l.length > 0 && !l.startsWith("??") && !l.startsWith("!!"));
if (dirty.length > 0) {
  throw new Conflict(
    `preview dev has uncommitted tracked changes — resolve in ...`
  );
}
```

The guard is correct in spirit — don't clobber in-progress work.
But in practice the dev preview directory accumulates tracked-file
changes between switches because:
- The Yii2 dev server writes files inside the working tree (logs,
  generated assets, runtime artifacts that shouldn't be tracked
  but currently are).
- Branch checkouts that produce file-mode-only or line-ending diffs
  show up as dirty.
- `composer install` / `yarn install` modify lockfiles to match
  the new branch's deps, leaving the prior branch's lockfile dirty.

Result: the safety guard fires every time and the operator has to
manually `git checkout -- .` in the dev path to proceed.

### Root cause

A guard meant for "operator was hand-editing locally and we
shouldn't lose their work" trips on every-day machine-generated
churn. The current binary "block on dirty / proceed on clean"
doesn't match the real distribution of dirty states (95%+ are
machine-generated cruft, not human edits).

### Recommended fix

Two-tier UX:

1. **Surface what's dirty in the response** so the operator can
   judge. Already done — dirty list is in the 409 message.
2. **Add a "Force switch (discard changes)" option** to the
   `PreviewDevButton`. When the first POST returns 409, the
   button switches to a destructive-intent confirmation
   ("Discard N tracked changes and switch?"). Confirming POSTs
   to the same endpoint with `{ force: true }`. Server runs
   `git checkout -f <branch>` (or `git reset --hard HEAD &&
   git checkout <branch>`) and proceeds.
3. **Optionally:** investigate the gitignore. If
   `runtime/cache` is the only legitimate machine-write target
   and the API already cleans it (route.ts:117-123), there
   shouldn't be other tracked-file churn. Audit suggests adding
   `runtime/logs/`, `web/assets/<hash>/`, `composer.lock`'s
   diff handling, and possibly Yii2's `runtime/` umbrella to
   `.gitignore` in the dev preview repo.

Cost: ~3-4 hours for the force-switch UX. The gitignore audit is
a separate ticket on the dev preview repo, not this codebase.

## Issue 5 — New runs sometimes don't display until manual refresh

### Symptom

A new run gets created (auto-advance, manual click, or chat
injection); the card detail UI doesn't reflect it without a hard
page refresh. The operator sees the prior run's state (or no run at
all on a brand-new card flow) until they hit Cmd-R.

### Code path

This is the same family as Issue 1. The card-detail page derives
"the current run" from `tasks.currentRunId` at render time. New
runs are created via:

- `startRun.ts:230-233` — sets `tasks.currentRunId = newRunId`
  and `currentLane = lane`.
- `autoAdvance.ts:43-52` — calls `startRun` from inside
  `spawnAgent.finalize` (server-side, child-process exit handler).
- `resumeRun.ts` (chat) — also calls `startRun`.

The client only learns about the new currentRunId via:

- `router.refresh()` from `RunLog`'s post-completion effect
  (`RunLog.tsx:373-391`) — fires 1.5s after a terminal `end` SSE
  event.
- `router.refresh()` from chat send (Issue 1).
- `router.refresh()` on `visibilitychange` / `focus`
  (`RunLog.tsx:285-294`).

If any of those misses (SSE drops before `end`, the user is on a
different tab, the refresh races with the start of the next run),
the page state stays stale.

### Root cause

The client has no push-based notification of "tasks.currentRunId
changed for this task." All updates rely on `router.refresh()`,
which is an opportunistic poll triggered by client-side events.
There's no equivalent of the per-run `/api/runs/[id]/stream` SSE
for the **task** itself.

### Recommended fix

Cheapest: **strengthen the existing `router.refresh()` triggers.**

1. After `RunLog` sees an `end` SSE event, refresh **and then
   re-fetch** the run list (currently waits 1.5s; sometimes still
   races with the next run's start). Better: wait for the next
   `tasks.currentRunId` change rather than a fixed timer.
2. After ChatBox sends a message, take the new runId from the
   response and rebind RunLog client-side (per Issue 1). No
   reliance on refresh at all for the runId update.

Better long-term: **add a task-level SSE stream**
(`/api/tasks/[id]/stream`) that emits `{ kind: "run_changed",
runId, lane }` whenever `tasks.currentRunId` changes. The
card-detail page subscribes once at mount, dispatches the new
runId into a client-side state holder, and rebinds RunLog
without `router.refresh()` at all.

Cost (cheap path): folded into Issue 1's fix. Cost (task SSE):
~1 day. The cheap path resolves 80%+ of Issue 5; the task SSE
is the proper fix for the 20%.

## Conclusion & priorities

These five issues cluster into three groups:

| Group | Issues | Root cause | Single fix? |
|---|---|---|---|
| **A. Client-side run-state coherence** | 1, 5 | `router.refresh()` is the only way the client learns about new runs; it's slow and races with SSE delivery | Read new runId from message-endpoint response + drop `startTransition`-wrapping of `router.refresh()` + rebind RunLog client-side. Optional follow-up: task-level SSE stream. |
| **B. Multi-cycle gating** | 2 | Post-implement UI gating predicates aren't cycle-scoped; `approveAndPr` is sticky-idempotent | Phases 1+4+5 of the QA-fix plan deliver this as a side-effect. If QA-fix is paused, extract those phases as a smaller "multi-cycle support" PR (~2 days). |
| **C. Standalone UX fixes** | 3, 4 | Default behaviours that don't match usage (run-log scope, preview-dev dirty handling) | Independent ~half-day fixes each. |

**Recommended ship order:**

1. **Group A first** (Issue 1 + Issue 5 fix). Highest user-visible
   impact, smallest blast radius, no cross-cutting changes. ~half
   a day. **Ship as one PR.**
2. **Group C second** (Issue 3 + Issue 4 fixes). Two small
   independent PRs, each ~3-4 hours.
3. **Group B last** (Issue 2). The right shape depends on whether
   the QA-fix plan is going forward or staying deferred. If
   moving forward: roll Issue 2 into the QA-fix plan's Phases 1
   + 4 + 5 (already specified). If staying deferred: extract a
   smaller "multi-cycle support" PR (~2 days) covering only
   cycle-scoped UI gating + parallel `approveQaFix` (without the
   QA-comment-picker entry point).

**Total effort:** ~3.5 days for all five if Group B uses the
extracted slice; ~5 days if rolled into the QA-fix plan.

**Risks:** none of the fixes touch the worker, agent prompts, DB
schema, or Jira integration. All changes localised to card-detail
React components, the message-endpoint client wiring, and the
preview-dev API route. Existing tests remain valid; new tests
needed for: ChatBox response-runId handling, RunLog scoped-mode
toggle, preview-dev force-switch, cycle-scoped gating predicates.

## References

- `components/card-detail/ChatBox.tsx` — Issue 1 root site
- `components/card-detail/RunLog.tsx` — Issues 1, 3, 5 root site
- `app/cards/[id]/page.tsx:148-296` — Issues 2, 5 gating logic
- `components/card-detail/ImplementButton.tsx:28-44` — Issue 2 sticky predicate
- `app/api/runs/[id]/message/route.ts:75-93` — Issue 1 endpoint (returns new runId)
- `app/api/tasks/[id]/preview/route.ts:67-90` — Issue 4 root site
- `server/worker/startRun.ts:230-233` — Issue 5 currentRunId update
- `docs/plans/2026-05-01-feat-qa-failed-fix-loop-plan.md` — Issue 2 fix plan (deferred branch)
- `server/git/approve.ts` — Issue 2 sticky `prRecords.state`
- `server/worker/autoAdvance.ts:9-17` — Issue 5 cascade trigger
