---
title: Post-Implement Test Lane (Playwright)
status: draft
date: 2026-05-08
topic: post-implement-test-lane
---

# Post-Implement Test Lane (Playwright)

After `implement` finishes and the branch is pushed, we want a new lane
that runs the managed repo's Playwright suite against the agent's
changes, captures pass/fail, and feeds a clean signal back into the
existing flow — so a green run lands the card on `done`, and a red run
either holds the card on `test` for operator review or kicks the
existing QA-Fix loop automatically.

The Playwright tests live in the managed repo (e.g. `BASE_REPO`,
currently `/var/www/lawrenze.multiportal.io`) on branch
`marben-qa-test`. They are not in the aiops orchestrator repo. The
test lane spawns commands inside the per-task worktree
(`WORKTREE_ROOT/<JIRA>-ai`), which is exactly where `ce:work` already
runs — same cwd, same env, same git checkout.

## What we're building

Concretely, four pieces:

1. **A new lane `test`**, slotted between `implement` and `done`, in:
   - `server/db/schema.ts` — tasks table enum (line 88-95) and runs
     table enum (line 140).
   - `server/agents/registry.ts` — extend the `Lane` union (line 10).
   - `server/worker/autoAdvance.ts` — add `implement: "test"` and
     `test: null` (terminal until either auto-`done` or operator
     intervention; see Open Questions).
   - `server/worker/persistArtifacts.ts` — register `LANE_TO_KIND` for
     `test` so the agent's output file gets ingested.
   - All UI references in `app/cards/[id]/page.tsx`,
     `components/card-detail/ArtifactPanel.tsx`,
     `components/card-detail/CardMainTabs.tsx`, the lane chip in the
     swimlane board, etc.

2. **A new agent `test:playwright`** in the registry. Unlike planning
   agents, this one's job is mostly bash:
   - Detect Playwright (`package.json` has `@playwright/test` and a
     `test:e2e` or `playwright.config.*` file).
   - Run `pnpm playwright install --with-deps` (idempotent) then
     `pnpm playwright test --reporter=list,json` against the
     worktree's branch. Stream output through the existing
     stream-json pipeline (works as-is — Claude wrapping bash is what
     `ce:work` already does on `bypassPermissions`).
   - Parse the JSON reporter output and write
     `docs/tests/<JIRA>-test.md` with: verdict (PASS/FAIL), counts,
     a short summary of failed specs (file, title, error excerpt),
     and a link/path to the full HTML report saved under the worktree.
   - On FAIL, exit non-zero so `decideExitStatus` flags the run as
     `qa_failed` (existing path — already wired for cost-kill /
     non-zero exits).

3. **A finalisation step** mirroring `implementComplete.ts` but
   simpler — call it `testComplete.ts`:
   - On PASS: post a Jira comment ("✅ Playwright suite passed — N/N
     tests, branch `<JIRA>-ai`"), transition Jira to "QA Passed" (or
     whatever the project's column is), and move `currentLane` to
     `done`.
   - On FAIL: post a Jira comment listing failing specs (operator
     can read them in Jira before opening the worktree), keep
     `currentLane = "test"`, and surface a **"Re-run Tests"** button
     on the card alongside the existing "Fix from QA" button.
     ("Fix from Tests" can reuse the QA-Fix-Loop start endpoint with
     the test-output markdown injected as findings — see
     `qaFixCycle` payload in `app/api/tasks/[id]/qa-fix/start/route.ts`
     — almost zero new code on the QA-Fix side.)

4. **A "skip tests" escape hatch**: an operator button on the
   `test` lane to manually advance to `done` when Playwright is
   broken for non-code reasons (flaky CI, infra outage, etc.).
   Logged via `audit({ action: "test.skipped", … })`.

## Why this approach

**Reuse the existing agent harness instead of a parallel runner.**
We already have a worktree, an authenticated Claude subprocess that
can run bash, a stream-json pipe to the run-events table, cost
tracking, and exit-code-driven status mapping. A `test:playwright`
agent that mostly shells out to `pnpm playwright test` gets all of
this for free — every other path (custom worker, `node:child_process`
in an API route, separate cron) reinvents at least one of those.
The Claude wrapper does add a small overhead vs. raw `spawn`, but
it preserves observability — the operator can see the test run in
the same UI panel as planning/implement runs without any new
plumbing.

**Slot between `implement` and `done`, not after `done`.** The
`done` lane today means "PR is open, Jira moved to Code Review,
human-or-QA owns it next." Tests should run *before* we declare
that — otherwise we're shipping unverified code as "done" and
relying on QA to be the first failure signal, which is exactly the
loop the QA-Fix-Loop tries to short-circuit. Inserting `test`
upstream of `done` makes Playwright the first checker, and the
QA-Fix-Loop (already merged) handles the residual case where
Playwright passes but a human spots something.

**Reuse the QA-Fix-Loop on red.** No new failure mechanism. Failed
Playwright runs are structurally the same as failed manual QA — a
test artifact lists what's wrong, the operator decides whether to
re-flow. Even better: a "Auto-fix from tests" toggle (later) could
skip the operator click and feed the failure JSON straight into a
new `brainstorm` cycle. Build the manual button first; automate
later if we trust the signal.

## Key decisions

- **Lane name: `test`** (lowercase, single word — matches existing
  style). Not `qa`, `playwright`, or `verify`.
- **Sequence:** `… → implement → test → done`. Auto-advance from
  `implement` to `test` once `implementComplete.ts` finishes
  pushing.
- **One agent for v1: `test:playwright`.** Other test runners
  (vitest e2e, Cypress, custom shell) can be added later as new
  agents on the same lane. Per-instance default lives in the
  setup-wizard + admin settings (`DEFAULT_TEST_AGENT`).
- **PASS auto-advances to `done`. FAIL holds on `test`.** Symmetric
  with how `review` AMEND/REWRITE holds on `review` instead of
  forcing forward.
- **Test artifact at `docs/tests/<JIRA>-test.md`** with
  frontmatter `ticket, date, status, verdict`. Same shape as other
  artifacts so `ArtifactPanel` and `ArtifactViewer` render it
  without special casing — register `"test"` as a kind in
  `server/db/schema.ts` artifacts enum (line 211-227).
- **Re-runs are first-class.** The "Re-run Tests" button starts a
  new `test:playwright` run on the same task without going back
  through `brainstorm`. Append-only artifacts table already
  supports this via `supersedesId`.
- **Skip-tests is a manual operator action**, never automatic.
  Audited.
- **Test command is read from the managed repo's `package.json`
  `scripts.test:e2e`**, with a hardcoded fallback to
  `pnpm playwright test`. This avoids a new instance-level setting
  for v1 — the project either has the script or it doesn't.

## How to test the feature during development

(The user's second question: how do I dogfood this against the
`marben-qa-test` branch from the managed repo while developing the
aiops `feat/implementation-handoff-improvements` branch?)

The aiops orchestrator is configured per-instance against one
managed repo via `BASE_REPO`. Dev workflow:

1. In a separate terminal, in the managed repo
   (`/var/www/lawrenze.multiportal.io` or wherever `BASE_REPO`
   points): `git fetch && git checkout marben-qa-test`. The
   per-task worktrees aiops creates branch off `BASE_REPO`'s
   currently-checked-out HEAD, so this puts Playwright in every
   new worktree without touching aiops.
2. Confirm via `git -C $BASE_REPO log --oneline -5 marben-qa-test`
   that Playwright is actually present (`playwright.config.*`,
   `tests/e2e/`, `package.json` script).
3. In aiops, stay on `feat/implementation-handoff-improvements`
   with the test-lane code added. `pnpm dev`. Take a real Jira
   ticket through `brainstorm → … → implement` against this setup
   — the new `test` lane will fire on completion and run
   Playwright against the agent's diff merged on top of
   `marben-qa-test`.
4. **Alternative if you don't want to flip the managed repo's
   default branch**: create a second worktree of the managed repo
   (`git -C $BASE_REPO worktree add /tmp/marben-tests
   marben-qa-test`) and temporarily point aiops's `BASE_REPO` at
   `/tmp/marben-tests` via `.env.local`. Reverse when done.

This is dev/integration guidance, not feature scope — capture it
in the plan as a "How to verify locally" section, not as code.

Eventually `marben-qa-test` should merge into the managed repo's
`main`, at which point step 1 is unnecessary and the test lane
just works for every task.

## Resolved Questions

1. **Playwright artifacts (HTML report, traces, videos) → persistent
   path.** Copy on run completion (PASS or FAIL) to
   `/var/aiops/test-reports/<JIRA>/<run-id>/` — survives worktree
   cleanup so the operator can pull up old reports without re-running.
   The path becomes a new env var (e.g. `TEST_REPORTS_ROOT`) with a
   sensible default and its own retention policy (mirror the nightly
   worktree GC — drop reports older than N days). Link from the
   `docs/tests/<JIRA>-test.md` artifact.

2. **Dev server → managed repo's `playwright.config.webServer`
   handles it.** aiops does not boot the app. The test agent runs
   `pnpm playwright test` and trusts the project to bring up its own
   server. Document this as a managed-repo requirement in the README
   / setup wizard.

3. **Jira transition on PASS → configurable, default no-op.** New
   admin setting `JIRA_TEST_PASS_TRANSITION` (blank by default).
   Always post a Jira comment with the verdict; only fire a
   transition when the setting is non-empty. Project-specific, so
   no hardcoded value will fit every deployment.

4. **Cost cap → global default ($5 warn / $15 kill).** No per-agent
   override in v1 — the agent is mostly orchestrating bash, so real
   token usage will be well under $1. Revisit only if the
   failure-diagnosis path starts burning meaningful tokens.

5. **Surfacing → lane chip with pass/fail count on the board.** Red
   `test` chip with "N failed" on FAIL, green with "N/N" on PASS.
   One extra DB read per card on the dashboard query (latest test
   artifact per task). Matches the existing run-cost chip pattern.

6. **Concurrency → in-memory mutex in the orchestrator.** Serialise
   `test:playwright` runs via an in-process queue (one at a time
   per aiops instance). No managed-repo requirements about random
   ports. Throughput cost is negligible since runs take minutes and
   ticket volume is low. Implementation: a small async queue in
   `server/worker/spawnAgent.ts` keyed on agent id — tests wait for
   the prior test to finish before spawning.

## Out of scope (for v1)

- Other test runners (vitest e2e, Cypress, Jest). Add as new
  agents later on the same lane.
- Auto-rerun on flake detection. Manual "Re-run Tests" button is
  enough for v1; flake detection needs historical signal.
- Sharding / parallel execution across machines. Single-machine
  serial runs only.
- Test-result trending / dashboards. The artifact history is
  enough.
- Visual regression diffs surfaced in the UI. Link to the
  Playwright HTML report instead.
