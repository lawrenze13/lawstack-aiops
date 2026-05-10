---
title: Test Runner Without Claude
status: draft
date: 2026-05-08
topic: test-runner-without-claude
---

# Test Runner Without Claude

The just-shipped `test:playwright` agent (PR #7) wraps `pnpm playwright
test` in a Claude subprocess. Claude reads a prompt, decides to run
bash, runs the tests, parses JSON, writes a markdown artifact, exits.
Looking at it honestly: ~99% of that work is mechanical and doesn't
benefit from LLM reasoning. We're paying token cost + non-determinism
for an LLM to be a bash script.

This brainstorm explores replacing the Claude wrapper with a simpler
runner — likely a plain shell or Node script the orchestrator spawns
directly — while keeping every other piece of the test-lane machinery
(lane state, mutex, persistArtifacts, testComplete, Jira comment).

## What we're building

A non-Claude test runner the orchestrator invokes for the test lane.
The agent registry still has `test:playwright` as the routing key, but
its `runnerType` flips from `"claude"` to `"script"`. `spawnAgent`
gets a thin branch: Claude-based agents go through the existing
`claude -p` path; script-based agents spawn a project-local shell or
node script directly with the same env-minimisation + worktree cwd +
stream-json-or-equivalent output piped into the `messages` table.

Same artifact shape (`docs/tests/<JIRA>-test.md`), same
testComplete flow, same Jira comment, same lane-to-done handoff.
Cost meter becomes a no-op for script runs (`cost_usd_micros = 0`).

## Why this approach

**Cost.** A Claude orchestration run for `pnpm playwright test` burns
around $0.10-$0.50 per invocation depending on suite size. Multiply by
N tasks/day across a real workflow — that's tokens for shell, not
reasoning. A bash script is free.

**Determinism.** Claude can hallucinate spec names, retry tools
weirdly, get stuck in turn loops, summarise failures incorrectly.
The same input to a shell script gives the same output every time.

**Speed.** Claude startup + token streaming overhead is ~5-15s before
any real work. Direct spawn is instant — Playwright starts running on
turn 1.

**Operator debuggability.** When Playwright fails, the operator wants
to read Playwright's actual output, not Claude's narrated retelling of
it. Direct spawn pipes raw stdout/stderr into the run log.

The flip side — what we'd lose by dropping Claude here:
- Adaptive failure triage (Claude could read a stack trace and
  suggest a likely cause). In practice the existing `Fix from Tests`
  loop already covers this — operator triggers a brainstorm cycle
  with the failures as findings, no in-line LLM needed.
- "Did the right tests run?" — Claude could spot if Playwright
  silently skipped a config. A `playwright test --list` pre-flight
  check in the script gives the same signal more reliably.

## Three approaches

### A) Direct script invocation (recommended)

A `scripts/run-playwright.sh` (or `.ts` for portability) that the
orchestrator spawns via `child_process.spawn` directly. The script:

1. Runs `pnpm playwright install --with-deps` (idempotent).
2. Runs `pnpm playwright test --reporter=list --reporter=json:test-results.json`.
3. Reads `test-results.json`, computes pass/fail counts.
4. Writes `docs/tests/<JIRA>-test.md` with the same frontmatter shape
   the testComplete parser already expects.
5. Exits 0 on PASS, non-zero on FAIL.

`spawnAgent.ts` adds a `runnerType` discriminator. Claude-based agents
keep their existing 400-line happy path. Script-based agents get a
new ~80-line `spawnScriptInner` that:
- Spawns the script with stdio piped.
- Streams stdout lines into `messages` as `type: "stream_event"` rows
  so the run log shows live test progress.
- Skips cost-meter init.
- Exits via the same `child.on("exit")` handler — releases the
  serialise-chain lock, runs the same finalize → persistArtifacts →
  testComplete chain.

**Pros:** minimal new infra; reuses every existing piece of the
test-lane machinery (mutex, finalize, testComplete, lane state); no
new processes or services to deploy; lowest possible blast radius.

**Cons:** still single-machine. If the team ever wants multi-machine
test isolation (separate test runner box, parallel runs across
managed repos, sandboxing per task), we'd revisit. Not a v1
constraint.

### B) Standalone test server (HTTP service)

A separate Node service running on `:4000` exposing
`POST /run-tests` that accepts
`{ runId, taskId, jiraKey, branchRef, baseBranch }`, runs Playwright
in isolation, POSTs results back to aiops via a callback URL.

Aiops's test lane becomes: queue a job → poll for completion (or
listen for the callback) → persist the artifact when done.

**Pros:** clean process isolation; can scale to multiple workers;
can run on a different machine (e.g. a beefy CI box separate from
the always-on aiops VPS); decouples test-running cadence from the
main process.

**Cons:** separate service to deploy + monitor; adds an HTTP
boundary with auth + retry concerns; queue coordination
(what happens when the test server is down? when aiops restarts
mid-run?); double the moving parts. Two deployments instead of
one.

Best suited when you have:
- Multiple aiops instances sharing a test runner pool.
- A separate ops team owning the test infrastructure.
- High enough run volume that one machine can't keep up.

None of those apply today.

### C) GitHub Actions / external CI

Tests run automatically when the PR is pushed (which approveAndPr
already does). Aiops polls the PR's `check_runs` API; when the
Playwright check completes, aiops persists the artifact and runs
testComplete.

**Pros:** zero local infra; scales for free; matches the rest of the
team's CI flow; gets you per-commit coverage on the PR independently
of the test lane.

**Cons:** requires the managed repo to have a working Playwright
GitHub Actions workflow (separate setup); slower feedback (queue
+ runner cold-start = 1-3 minutes minimum); operator-triggered
"Re-run Tests" needs a `workflow_dispatch` hook + waits for CI again;
relies on GitHub being up.

Best suited when:
- You're already running Playwright in GitHub Actions on every PR.
- You don't need real-time test results in the operator UI.
- You want to avoid managing a runtime for tests entirely.

Strong long-term answer for a multi-team setup. Premature for the
single-tenant single-VPS world this orchestrator runs in today.

## Recommendation

**A.** YAGNI. The orchestrator is single-machine, single-tenant, and
we already have the spawn pipeline. Adding a separate service or a
CI dependency is real ops cost; replacing one subprocess type with
another inside the same `spawnAgent` function is a one-day change
that pays for itself in tokens within the first week.

C becomes the right answer the moment the test suite outgrows a
single machine or the team picks up a CI culture. B is rarely the
right pick — it's "halfway to C" with most of C's complexity and
none of its leverage.

## Key decisions

- `test:playwright` agent stays in the registry as the routing key
  for the test lane; only its execution path changes.
- New `runnerType: "claude" | "script"` field on `AgentConfig`.
  Claude is the default (back-compat); test:playwright flips to
  `"script"`.
- New `script: string` field on script-runner agents — relative path
  resolved inside the per-task worktree (so the runner can live in
  the managed repo if desired) OR an absolute orchestrator-local
  path (for tools we ship with aiops).
- `spawnAgent` adds a runner branch. Same registry, same audit, same
  artifact pipeline; only the child process differs.
- Cost-meter init is skipped for script runs. Dashboard tiles handle
  `cost = 0` gracefully (already do today on cancelled / pre-init
  runs).
- The mutex stays — one Playwright run at a time per aiops instance.
  Same `serializeKey: "test:playwright:global"`.
- The script writes the same `docs/tests/<JIRA>-test.md` shape so
  testComplete + parseTestArtifact don't change.
- `test:author` (the future button from the Test-Author plan) stays
  Claude-based. Spec authoring is real reasoning work; the
  Claude/script split is per-agent, not per-lane.

## Resolved questions

1. **Script home → orchestrator-local with override.** Default lives
   at `scripts/run-playwright.ts` in aiops itself. New config setting
   `TEST_RUNNER_SCRIPT` lets a managed repo provide its own path
   when its conventions differ (custom reporters, fixtures, env
   vars). Every project gets working defaults; quirky projects opt
   into ownership.

2. **Language → Node TypeScript.** `tsx scripts/run-playwright.ts`.
   Shares `parseTestArtifact`'s frontmatter types via direct import,
   gets typed JSON parsing of `test-results.json`, breaks loud at
   compile time on shape drift instead of silently emitting wrong
   YAML.

3. **Upgrade → auto-flip to script.** On version bump, `test:playwright`
   in the registry switches `runnerType` from `"claude"` to
   `"script"` automatically. Artifact shape is unchanged so
   operators see no behavioural diff (just lower cost). No
   admin toggle, no migration step.

4. **Failure triage → raw stderr.** Playwright crashes that aren't
   test failures (Chromium missing, port 3000 busy, OOM) land as
   raw stderr in the run log. Truthful, fast, cheap. The
   Fix-from-Tests loop covers real test failures via a separate
   Claude brainstorm cycle; infrastructural failures are
   operator/ops issues that benefit from raw output, not
   narration.

5. **Cost UI → hide cost on script runs.** Skip the cost field in
   the run card / log header when `runnerType === "script"`. A
   `$0.00` label would be ambiguous against cost-killed Claude runs
   that also show $0. Hiding it cleans up the card and makes the
   absence implicit.

6. **Stream output → wrap each line as `stream_event`.** Each stdout
   line becomes a row in `messages` with
   `{ type: "stream_event", payload: { kind: "line", text } }`. The
   UI's existing renderer handles `stream_event` rows already, so no
   front-end change. Cheapest path to "the run log just works."
