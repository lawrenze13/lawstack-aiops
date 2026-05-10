---
title: Optional Test-Author Button (Playwright)
type: feat
status: active
date: 2026-05-08
---

# Optional Test-Author Button (Playwright)

## Overview

Adds an opt-in **"Author Tests"** button on the test and done lanes
that spawns a new `test:author` agent. The agent reads the
implementation ship-note's "User-visible changes" + "Test Plan"
sections, writes Playwright specs covering each new behaviour, then
commits + pushes them onto the existing `<JIRA>-ai` branch. The
operator follows up with a Re-run Tests click to verify the now-
extended suite, or relies on CI on the open PR.

This closes the gap left by the just-shipped test lane: today the
lane runs the *existing* Playwright suite (catches regressions only).
With test-author wired in, the operator can extend coverage to the
shipped change with one click — without bolting test-authoring
onto `ce:work` (which would conflate implementation reasoning with
test design and bloat its already-long prompt).

Strictly opt-in. The default flow on Approve Implementation stays:
`implement → test (regression run) → done`. Author Tests is an
additional manual action the operator can trigger at any point on
test or done — including retroactively for older tickets.

## Problem Statement / Motivation

The test lane (`feat/post-implement-test-lane`, PR #7) added a
`test:playwright` agent that runs the managed repo's Playwright
suite after Approve Implementation. It catches regressions but does
not cover the new feature itself — if a ticket adds a new button,
the test lane will pass without verifying that button works.

Three things drive a discrete agent over expanding `ce:work`:

1. **`ce:work` is already long.** The prompt covers ship-note,
   commit hygiene, NEEDS_INPUT triggers, interactive mode. Adding
   "and also write Playwright specs for every user-visible change"
   makes it brittle. Specialised agents win when scope is clear.
2. **Optional, not required.** A pure refactor doesn't need new
   tests; a copy-only change shouldn't trigger spec authoring.
   Operator judgement in the loop.
3. **Retroactive coverage.** With a button, the operator can
   author tests for tickets that landed before the test lane
   shipped, by visiting any `done` card.

## Proposed Solution

A new agent `test:author` and a button that triggers it.

**Trigger surface.** A new `AuthorTestsButton` component renders on
the card-detail header when:
- `currentLane === "test"` or `currentLane === "done"`
- the operator is owner/admin
- no run is currently active for the task

Click → POST `/api/tasks/:id/runs` with `{ lane: "test", agentId:
"test:author" }`. The route's lane enum already accepts "test"
(landed in the test-lane PR) — we just allow a non-default agent on
the same lane.

**Agent behaviour.** `test:author` (sonnet, `bypassPermissions`)
runs in the per-task worktree. Its prompt instructs it to:

1. Read `docs/implementation/<JIRA>-implementation.md`. Extract the
   **User-visible changes** and **Test Plan** sections via the
   shared `extractShipNoteSections` helper from `server/jira/shipNote.ts`.
2. Survey the project's existing Playwright tests for style and
   helper conventions: `find tests -name "*.spec.ts"` (or whatever
   pattern the managed repo uses), read 2-3 specs to match
   imports, fixtures, page-object patterns.
3. Write one new spec per user-visible change (or one shared
   `<JIRA>.spec.ts` covering all changes if they're tightly
   related). Place under the project's existing tests dir
   (auto-detected from playwright.config — `testDir`). Each test
   maps directly to a bullet from the Test Plan.
4. Commit the new spec files via `git add tests/... && git commit
   -m "test(<JIRA>): add Playwright coverage for ..."`. The same
   `bypassPermissions` mode used by `ce:work` lets bash + git work
   unprompted.
5. Push to `<JIRA>-ai` via `robustPush` (existing helper at
   `server/git/push.ts`). Failures are surfaced via NEEDS_INPUT.
6. Write `docs/test-author/<JIRA>-test-author.md` summarising what
   specs were added, with frontmatter listing each filename. This
   is the artifact `persistArtifacts` ingests; renders in the card
   detail tab list.
7. Exit 0.

**Server finalisation.** Mirrors `ce:work`'s minimal-finalize path
(no `testAuthorComplete.ts` needed):
- `spawnAgent.finalize` already calls `persistArtifactsForRun` on
  completed runs; the new artifact lands automatically.
- New audit row `test.author_complete` (success) or
  `test.author_failed` (error) is written by the agent's
  post-run hook in `spawnAgent.finalize`'s success branch.
- Best-effort Jira comment posting: a small new helper
  `server/jira/testAuthorComment.ts` posts a "🧪 Tests authored —
  N specs added on branch X" ADF comment. Non-fatal.
- Lane stays on `test` (or `done`). The button does NOT advance
  the lane — operator decides whether to Re-run Tests next.

**Skip semantics.** The Author Tests button is purely additive. It
does not gate any existing flow. If the operator never clicks it,
the test lane behaves exactly as it does today.

## Technical Considerations

- **Agent commits + pushes directly.** Departs from `ce:work`'s
  contract (which leaves changes uncommitted for server-side
  Approve Implementation). Justified because:
  - Scope is bounded: only new files under `tests/`, never edits to
    source code. A constraint enforced by the prompt.
  - The diff is reviewed in the existing PR's CI run + GitHub PR
    review — same review path as the implementation itself.
  - Rolling back is one `git revert <sha>` if the operator
    disagrees with the generated specs. Lower stakes than reverting
    a misguided implementation.
- **No new lane.** Reuses `test`. Two agents can run on the same
  lane (precedent: `review` lane has `ce:review`, `security:review`,
  `perf:review`, `deploy:check`).
- **No new mutex requirement.** `test:author` doesn't run
  Playwright itself, so the global `test:playwright:global`
  serialisation key doesn't apply. If concurrent author runs
  collide on the same worktree, that's fine — different tasks
  have different worktrees.
- **Spec placement.** Detect via `playwright.config.{ts,js,mjs}`'s
  `testDir`. Fallback: `tests/e2e/`. Fail loud (write the artifact
  with a "could not detect tests dir" warning + exit non-zero) if
  neither exists — the project isn't ready for this feature.
- **Agent reads `priorArtifacts`.** Same loader as planning
  agents, so the implementation.md is in scope without an
  additional fs read.
- **Cost cap.** Default ($5 / $15). Spec authoring is bounded and
  Claude doesn't need many turns to write a few specs. Bump only
  if real runs show otherwise.

## System-Wide Impact

- **Interaction graph:** click → `POST /api/tasks/[id]/runs` →
  `startRun(lane: "test", agentId: "test:author")` → `spawnAgent`
  (no serializeKey — runs in parallel with anything except other
  test:author runs on the same task) → agent writes specs +
  commits + pushes → `child.exit` → `persistArtifactsForRun` lands
  the test-author artifact → finalize emits run.completed bus
  event → UI refreshes; the Tests-Authored chip and a new entry
  in the History tab appear.
- **Error propagation:** Push failures emit NEEDS_INPUT (existing
  pattern); operator gets a banner. fs/IO errors land as
  `test.author_failed` audit + a non-zero exit, lane stays
  unchanged.
- **State lifecycle:** Specs are committed to the existing
  `<JIRA>-ai` branch. The PR sees them on next push. No orphaned
  state: if the agent crashes after `git add` but before
  `git commit`, the worktree's index has staged files; next run or
  cleanup will surface them via `git status`.
- **API surface parity:** None — Author Tests is a one-way
  trigger, not a state machine extension. No matching agent-tool
  surface needed (no MCP / agent-native gap).
- **Integration test scenarios:**
  1. Card on `test` with implementation.md present + Playwright
     configured → click Author Tests → assert new spec file in
     worktree, audit `test.author_complete`, Jira comment posted,
     test-author artifact ingested.
  2. Card on `done` (older ticket) → same flow, branch is at the
     PR head (already merged or open), specs commit + push.
  3. Project without `playwright.config` → agent writes artifact
     with SKIPPED verdict + warning, exits 0, no commit, no Jira
     comment.
  4. Implementation.md missing required sections → agent emits
     NEEDS_INPUT asking the operator to fill in the Test Plan.
  5. Push fails (non-fast-forward, etc.) → robustPush rebases +
     retries (same path ce:work uses); on hard failure NEEDS_INPUT
     surfaces the error.

## Acceptance Criteria

### Functional Requirements

- [ ] New agent `test:author` registered in
      `server/agents/registry.ts` with sonnet model,
      `bypassPermissions`, default cost caps,
      `produces: { kind: "test-author", dir: "docs/test-author" }`,
      and a prompt builder that reads implementation.md sections
      via `extractShipNoteSections`.
- [ ] New artifact kind `"test-author"` added to
      `server/db/schema.ts` artifacts.kind enum + the UI kind
      unions in `app/cards/[id]/page.tsx`,
      `components/card-detail/{ArtifactPanel,ArtifactViewer,
      CardMainTabs}.tsx`. KIND_LABEL: "Tests authored".
      KIND_ORDER: after `"test"`.
- [ ] New `LANE_TO_KIND` entry (or rather: agent's `produces`
      override) routes the artifact to `docs/test-author/`. The
      lane default for `"test"` stays `"test"` for `test:playwright`.
- [ ] `defaultAgentForLane("test")` continues to return
      `"test:playwright"` — `test:author` is non-default.
- [ ] Button: new `components/card-detail/AuthorTestsButton.tsx`
      visible on test + done lanes, owner/admin, no active run.
      POST `/api/tasks/:id/runs` with lane="test",
      agentId="test:author".
- [ ] Card detail page renders the button alongside Re-run / Fix /
      Skip on test, and alongside Fix from QA on done.
- [ ] New `server/jira/testAuthorComment.ts` posting a "🧪 Tests
      authored" ADF comment. Non-fatal on failure (warn-only).
- [ ] Audit rows `test.author_started` (on run start) and
      `test.author_complete` / `test.author_failed` (on finalize)
      so cycle reporting + future tile visualisations have data
      to query.

### Non-Functional Requirements

- [ ] Author run is idempotent against an empty diff: if no
      user-visible changes are listed (e.g. pure refactor), the
      agent writes a SKIPPED artifact and exits without
      committing. No no-op commits in the PR history.
- [ ] Generated specs use the project's existing Playwright
      conventions (helpers, fixtures, page objects). The agent's
      prompt reads 2-3 existing specs before writing.
- [ ] Spec filenames are deterministic (`<JIRA>-<slug>.spec.ts` or
      `<JIRA>.spec.ts`) so re-running Author Tests overwrites
      cleanly instead of stacking duplicates.
- [ ] Author Tests does not block or interact with the
      `test:playwright` global mutex — they're independent agents
      that happen to share a lane.

### Quality Gates

- [ ] Unit test for `test:author` agent registration
      (mirrors the lane-enum + agent-registry tests from PR #7).
- [ ] Manual test: take a real ticket through the test lane,
      click Author Tests, confirm specs commit + push and the new
      artifact renders. Then click Re-run Tests and confirm the
      extended suite runs the new specs.
- [ ] Linting + typecheck clean.

## Success Metrics

- **Adoption rate:** % of tickets where the operator clicks Author
  Tests after Approve Implementation. Target after 2 weeks: >0
  (any usage signals the lane is doing work; high usage signals
  it's worth investing in auto-trigger heuristics).
- **Spec quality (manual review):** % of generated specs that pass
  on first Re-run Tests. Below 50% means the agent prompt or the
  implementation.md Test Plan section needs sharpening.
- **Coverage delta:** number of new Playwright specs landed via
  Author Tests over a 30-day window. Roughly tracks how much
  coverage we'd otherwise lose by relying on humans.

## Dependencies & Risks

- **Depends on PR #7** (`feat/post-implement-test-lane`) being
  merged first. The test artifact kind, lane enum, and shared
  helpers (parseTestArtifact, etc.) all land there.
- **Depends on `extractShipNoteSections`** from
  `server/jira/shipNote.ts` (already shipped on
  `feat/implementation-handoff-improvements`, PR #6 area).
- **Risk: agent generates low-quality specs.** Mitigated by the
  prompt requiring it to read 2-3 existing specs first, and by
  the manual Re-run Tests gate the operator controls. Bad specs
  would land in CI on the PR; reviewer catches them.
- **Risk: agent commits unrelated edits.** Mitigated by the
  prompt's hard rule "do NOT modify any source files outside
  tests/" + the bounded worktree env. A misbehaving agent's diff
  would be visible in the PR.
- **Risk: spec filenames collide across re-runs.** Mitigated by
  deterministic naming — re-runs overwrite, don't stack.

## Implementation Phases

### Phase 1 — Agent + button (0.5 day)

- `server/agents/registry.ts`: add `testAuthorPrompt(ctx)` builder
  + `AGENTS["test:author"]`.
- `server/db/schema.ts`: artifact kind + `"test-author"`.
- `server/worker/persistArtifacts.ts`: ArtifactKind union (the
  `produces` field on the agent already routes the dir, so no
  LANE_TO_KIND change needed).
- UI kind unions: `app/cards/[id]/page.tsx`,
  `components/card-detail/{ArtifactPanel,ArtifactViewer,CardMainTabs}.tsx`.
- New `components/card-detail/AuthorTestsButton.tsx`.
- Wire button into `app/cards/[id]/page.tsx` header.
- Confirm `app/api/tasks/[id]/runs/route.ts` accepts
  `agentId === "test:author"` (no allowlist beyond
  `agent.lanes.includes(lane)`; should already work).

### Phase 2 — Jira comment + audit polish (0.25 day)

- `server/jira/testAuthorComment.ts`: ADF builder for the
  "Tests authored" comment with the new spec list.
- `spawnAgent.finalize` success branch: when
  `agent.id === "test:author"`, post the comment + audit
  `test.author_complete`. On failure, audit `test.author_failed`.
- Audit `test.author_started` from `startRun` (matching the
  pattern of `qaFixCycle` metadata in run.started_request payload).

### Phase 3 — Manual verification (0.25 day)

- Same dogfood pattern as PR #7 (point `BASE_REPO` at
  `marben-qa-test`, run aiops, take a ticket through Approve
  Implementation, click Author Tests, verify specs commit + push,
  click Re-run Tests, verify they pass).

## Sources & References

- **Test lane PR (prerequisite):** [#7
  feat/post-implement-test-lane](https://github.com/lawrenze13/lawstack-aiops/pull/7).
  Plan:
  [`docs/plans/2026-05-08-feat-post-implement-test-lane-plan.md`](2026-05-08-feat-post-implement-test-lane-plan.md).
- **Ship-note parser:** `server/jira/shipNote.ts`
  `extractShipNoteSections`. Carries the User-visible changes +
  Test Plan sections from `docs/implementation/<JIRA>-implementation.md`.
- **Agent registration template:** `server/agents/registry.ts`
  — `playwrightTestPrompt` + `AGENTS["test:playwright"]` (added
  in PR #7) is the closest pattern. Sonnet, bypassPermissions,
  short prompt, `produces` field for artifact routing.
- **Robust push:** `server/git/push.ts` — handles missing
  upstream + non-fast-forward rebase. Reuse for the agent's
  push step.
- **Audit + Jira comment pattern:** `server/git/implementComplete.ts`
  Step 2 + `server/jira/qaFixComment.ts` show the
  audit-log-dedupe + ADF-comment template the test-author
  finalize should mirror.
