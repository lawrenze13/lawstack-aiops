---
title: QA-Failed Fix Loop
status: active
date: 2026-04-30
topic: qa-failed-fix-loop
---

# QA-Failed Fix Loop

When manual QA fails on a task that has reached the `done` lane (PR
pushed, Jira transitioned to Code Review) and QA leaves their findings
as comments on the Jira ticket, the operator needs a one-click way to
re-flow the card through `brainstorm → plan → review → implement` with
those findings as input — and have Jira informed when the fix lands.

## What we're building

A new card-detail action — **"Fix from QA"** — visible on tasks whose
`current_lane === "done"`. Clicking it:

1. Opens a modal listing every Jira comment created **after** the card
   hit `done`. Operator ticks the comments that are actual QA findings
   (vs. questions, manager nudges, jokes). At least one must be
   selected; an optional "extra context" textarea is **deferred** —
   for v1, comment selection is the only input.
2. On confirm, starts a fresh `ce:brainstorm` run with the selected
   comments injected under a `## QA findings` heading in the prompt,
   plus a `qaFixCycle: true` flag in the run-start request payload.
3. The card moves back to the `brainstorm` lane. **Auto-advance**
   (`server/worker/autoAdvance.ts`) carries it forward — same
   mechanism the AmendPlan flow uses today: Brainstorm completes →
   auto-advance to Plan → ce:plan runs → auto-advance to Review →
   ce:review runs → auto-advance to Implement → `ce:work` runs.
   Worktree is still live in `done`, so all four runs share the
   existing checkout.
4. `ce:work` finishes the same way it does on first-time
   implementation: leaves uncommitted changes in the worktree, emits
   `implement.awaiting_approval`, card sits on `implement` lane.
   The operator clicks **Approve & PR** — same button, same gate —
   the **second human checkpoint** (the first was clicking
   "Fix from QA"; this one confirms the agent's fix is push-ready).
5. `implementComplete.ts` gets a QA-cycle branch (detected via
   `wasQaFixCycleRun(runId)` reading the audit log for the
   `run.started_request` payload of the brainstorm run that opened
   this cycle). On the QA-cycle path it:
   - Skips PR creation (PR exists from the original cycle).
   - Calls `robustPush` to attach the new commits to the same branch.
   - Posts **`postQaFixComment`** (parallel to `postAmendmentComment`)
     instead of the original implementation comment — single comment
     per cycle, after the push lands.
   - Skips the Jira "Code Review" transition (already there).
   - Moves `currentLane` back to `done`.

The button is hidden when `status === "archived"`.

Surfacing the cycle:

- **Iteration counter chip** on the card header: `QA cycle: N`,
  computed as `COUNT(*) FROM runs WHERE task_id=? AND lane='brainstorm'`.
- **Run history tab** in card detail listing every prior run (lane,
  agent, cost, started_at). Mostly already wired — runs are loaded
  into the page query — just needs a tab in `CardMainTabs`.
- **Artifact version dropdown** in `ArtifactViewer`: walks the
  `supersedesId` chain so the operator can pick `brainstorm v1`,
  `v2`, `v3` from the DB. The on-disk file stays single-version
  (necessary so `ce:work` reads a stable filename) — the UI sources
  history from the append-only `artifacts` table.

## Why this approach

**Manual button over polling/webhooks.** Mirrors the existing
`AmendPlanButton` precedent exactly. Zero infra. The operator is
already reading the QA comment in Jira when they decide to act —
adding a button on the card is the lowest-friction path. Automation
(Jira webhook on QA-failed status, or comment-poller) can come later
once we have signal on whether the manual flow is too tedious.

**Full re-flow over short-circuit.** QA failures often surface
scenarios the original brainstorm didn't consider (empty states,
mobile breakpoints, race conditions, …). Re-running from
`brainstorm` lets the agent re-shape the requirements, then the plan,
then the implementation. Skipping to `implement` would patch
symptoms; we want the agent to re-think.

**Review stays in the cascade.** The Review verdict gate
(`P2_BLOCKER`) is what catches half-baked fixes before they land back
in QA's queue. Skipping Review on QA loops would be a YAGNI invert —
adding "if qaFixCycle, skip review" introduces conditional logic for
an unproven concern. If Review turns out to be noise on small fixes,
easier to skip then than to add it back.

**Operator-curated comment selection.** Auto-pulling all Jira
comments since `done` would feed the agent every Slack-bridge ping
and PM stand-up note. Checkbox selection is more clicks than
auto-pull, but exactly the right level of curation: the operator
already knows which comments are QA findings, the click cost is
small (typically 1-2 comments), and the agent gets a clean signal.

**Append-only artifacts + UI version dropdown.** The DB already
preserves every version of every artifact via `supersedesId`. The
gap is purely UI — `latestArtifactByKind` reduces the query to a
single row per kind, hiding history. The fix is to surface the chain
in `ArtifactViewer` rather than change the persistence model. The
filesystem overwrite is a feature (downstream agents need a stable
canonical filename), not a bug.

**Dedicated `postQaFixComment` over reusing
`postAmendmentComment`.** The existing amend-comment is shaped
around "Plan amended from Review verdict" — wrong frame for QA
failures, where the fix targets implementation against external QA
findings, not internal Review verdicts. A parallel handler keeps each
comment's wording tight and lets the two flows evolve independently.

## Key decisions

| Decision | Choice |
|---|---|
| Detection | Manual `Fix from QA` button on cards in `done` |
| Cascade | Full re-flow: `brainstorm → plan → review → implement` |
| Review on loops | Stays in (no skip-on-QA exception) |
| Input mechanism | Operator picks comments via checkbox modal |
| Comment scope | Comments created after the card hit `done` |
| Same branch / same PR | Yes — worktree is alive in `done`, push attaches to existing PR |
| Same task | Yes — single task spans all QA cycles |
| Run-start flag | `qaFixCycle: true` (parallel to `amendFromReview: true`) |
| Detection on finalize | `wasQaFixCycleRun(runId)` reads run-start audit row |
| Jira-comment trigger | New `postQaFixComment`, fires from `implementComplete.ts` after the operator clicks Approve & PR and `robustPush` succeeds (one comment per cycle, not per lane) |
| Completion path | Operator clicks Approve & PR — same button as original; `implementComplete.ts` gets a QA-cycle branch (skip PR creation, post QA-fix comment, skip status transition, lane → done) |
| Cycle counter | `QA cycle: N` chip on card header, sourced from `runs` count |
| History UI | New tab in `CardMainTabs` listing every prior run |
| Artifact history | Version dropdown in `ArtifactViewer`, walks `supersedesId` chain |
| Diffs between versions | Out of scope (option 4 deferred) |
| Permissions | Same gate as `AmendPlanButton` — owner or admin |

## Resolved questions

1. **How does the system learn QA failed?** → Manual button only.
   Polling/webhook deferred until the manual flow demonstrates need.
2. **Which lane does the card return to?** → `brainstorm`. Full
   re-flow ensures QA findings inform every layer of the rebuild.
3. **Does Review re-run on QA loops?** → Yes. The existing verdict
   gate is the safety net against shipping a bad fix back to QA.
4. **What does the agent receive as input?** → Operator-selected Jira
   comments (≥1 required), injected under `## QA findings` in the
   `ce:brainstorm` prompt. No extra-context textarea in v1.
5. **Does the operator see iteration history?** → Yes. Counter chip +
   run history tab + artifact version dropdown. No diff view.
6. **Does Jira get notified when the fix is pushed?** → Yes — a new
   `postQaFixComment` handler fires from `implementComplete.ts` after
   the operator clicks Approve & PR and `robustPush` lands the new
   commits. Without this, QA has no signal to re-test.
7. **Same branch / new branch?** → Same. Worktree is alive in `done`,
   `ce:work` writes uncommitted changes, Approve & PR pushes them to
   the existing branch, the PR auto-updates.
8. **Same task or new task?** → Same task. The whole point of cycle
   counting + artifact history is to keep the QA loops on one card.
9. **How does the cycle terminate?** → Operator clicks Approve & PR
   (same button as the original cycle). `implementComplete.ts` gains
   a QA-cycle branch that skips PR creation, posts the QA-fix
   comment, skips the Code Review status transition, and moves the
   lane back to `done`. Two operator clicks per cycle: "Fix from QA"
   to start, "Approve & PR" to land.

## Open questions

These are real but solvable in the plan phase, not blockers for
brainstorm sign-off.

1. **Worktree pruning.** Today the cron prunes orphans >24h. A card
   that sits in `done` for 25+ hours before QA fails would have its
   worktree gone. Either (a) skip pruning while a worktree's task is
   in `done`, or (b) re-create the worktree on `Fix from QA` click
   (same code as initial Branch lane). (b) is more robust; (a) is
   simpler. Decide in plan.

2. **Jira status transition on fix-pushed.** Does your Jira workflow
   have a clean "Ready for QA" / "QA Failed → Fix Pending" → "Ready
   for QA" cycle? If yes, the `postQaFixComment` should also
   transition status. If your workflow only uses comments, the
   transition is no-op. Needs you to confirm the status names.

3. **Cost caps per cycle vs cumulative.** Each QA cycle re-runs four
   agents (brainstorm, plan, review, ce:work). Today's per-run cost
   caps apply per run; over 5 cycles a card could rack up 20 agent
   runs and significant spend. Add a per-task cumulative warn line
   (e.g., "QA cycle 4 — task has spent $42 across 16 runs"), or
   leave per-run caps and let the dashboard catch outliers? Default
   to per-run caps for v1; revisit if a card actually loops 5+ times.

4. **Concurrent click protection.** Operator double-clicks "Fix from
   QA" — guard with the existing `runActive` check (already used by
   `AmendPlanButton`) plus an idempotency token on the run-start
   request.

5. **QA-cycle limit / circuit breaker.** Should the system warn or
   block at e.g. cycle 5? A card that's been through QA 5 times is
   probably a "human, please look at this" signal, not a "let the
   agent loop again" one. Likely just a banner, not a hard block.

6. **Comments with attachments / screenshots.** `getIssueComments`
   returns ADF-flattened plaintext today. QA screenshots become
   `[image: foo.png]` or are dropped entirely. The agent loses
   visual context. v1 lives with this; if it bites we add ADF →
   image-URL extraction in the comment selector modal so the agent
   can `WebFetch` the screenshots.

7. **What counts as "after `done`" for comment filtering.** Use the
   `audit_log` row `task.lane_changed` with `to: "done"` as the
   timestamp. Comments with `created` after that timestamp are
   eligible for the picker. (If multiple QA cycles happened, use
   the most recent transition into `done`.)

## Success criteria

- An operator on a card in `done` clicks **"Fix from QA"**, sees the
  comments-since-done modal, ticks two QA findings, hits Run.
- The card moves to `brainstorm` lane and the full cascade runs
  through to `ce:work` pushing new commits to the existing PR.
- A Jira comment lands on the ticket within ~30s of `ce:work`
  completion saying "QA fix pushed for round 2 — ready for re-test"
  with the new commit shas and the PR link.
- The card header shows `QA cycle: 2` chip.
- Opening the brainstorm artifact in card detail offers a `v1 / v2`
  dropdown; selecting `v1` shows the original brainstorm.
- Run history tab lists 8 runs (4 lanes × 2 cycles).
- If QA fails a third time, the same flow works — no special-casing.

## Scope boundaries (explicitly out)

- **Auto-detection of QA failure.** No polling, no webhooks, no Jira
  status watchers. Manual button only.
- **Skip-Review-on-QA-cycles.** Review re-runs every time.
- **Side-by-side artifact diffs.** Version dropdown only; no diff view.
- **New branch / new PR per cycle.** Same branch, same PR, additive
  commits.
- **New task per cycle.** Same task spans all cycles.
- **Free-form operator note alongside selected comments.** Pure
  comment-selection input for v1.
- **Per-task cumulative cost cap.** Per-run caps continue to apply;
  cumulative spend visible only via the dashboard.
- **QA-cycle hard limit.** No circuit breaker; revisit if cards
  actually loop 5+ times.
- **Image / attachment extraction from Jira comments.** Plaintext
  ADF flattening only.
- **Smart deduplication of QA findings across cycles.** If QA flags
  the same bug twice, the agent gets it twice — no merging.

## References

- Existing precedent: `components/card-detail/AmendPlanButton.tsx`
  (manual-button + flagged run-start), `server/jira/amendComment.ts`
  (`postAmendmentComment`, `wasAmendmentRun`).
- Run-start dispatch: `server/worker/startRun.ts` (handles
  `amendFromReview: true`; `qaFixCycle: true` slots in next to it).
- Run-finalize dispatch: `server/worker/spawnAgent.ts:419-446` (the
  block that calls `wasAmendmentRun` → `postAmendmentComment` after
  artifact persistence; mirror this for QA-fix).
- Comment fetch: `server/jira/client.ts:166` (`getIssueComments`).
- Artifact persistence + supersedes chain:
  `server/worker/persistArtifacts.ts` (DB-side history is
  append-only; UI just needs to surface it).
- Card UI: `app/cards/[id]/page.tsx:144-175` (`latestArtifactByKind`
  reducer that hides version history today).
- Artifact viewer: `components/card-detail/ArtifactViewer.tsx`
  (single-version view; needs a version dropdown).
- Card tabs: `components/card-detail/CardMainTabs.tsx` (place to add
  the run-history tab).
- Lane state: `server/db/schema.ts:75-117` (`tasks.current_lane`
  enum already includes the values we need).
- Worktree lifecycle: `server/git/worktree.ts` and the nightly cron
  in `server/cron/nightly.ts` (orphan-prune logic to extend or
  refresh).
- Implementation finalization: `server/git/implementComplete.ts`
  (the `Approve & PR` path; QA fix re-uses `robustPush` but does NOT
  re-run `transitionIssueToName` to "Code Review" — Jira is already
  there).

## Estimated scope

| Slice | Effort |
|---|---|
| `Fix from QA` button + comment-picker modal + new run-start path | 1 day |
| `qaFixCycle` flag + `wasQaFixCycleRun` detector + `postQaFixComment` handler | 0.5 day |
| Cycle counter chip on card header | 0.25 day |
| Run history tab in `CardMainTabs` | 0.5 day |
| Artifact version dropdown in `ArtifactViewer` (walk `supersedesId`) | 0.75 day |
| Worktree-revival path for cards >24h in `done` | 0.5 day |
| Tests + smoke + audit-log entries | 0.75 day |
| Docs + runbook | 0.25 day |

**~4.5 days of focused work.** No DB migration; no new dependencies;
all infra precedents already exist.
