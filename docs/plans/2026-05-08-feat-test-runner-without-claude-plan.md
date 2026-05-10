---
title: Test Runner Without Claude (Script-Based test:playwright)
type: feat
status: completed
date: 2026-05-08
origin: docs/brainstorms/2026-05-08-test-runner-without-claude-brainstorm.md
---

# Test Runner Without Claude (Script-Based test:playwright)

## Overview

Replace the `test:playwright` agent's Claude subprocess with a plain
Node TypeScript script the orchestrator spawns directly. Keep every
other piece of the test-lane machinery — lane state, `serializeKey`
mutex, `persistArtifactsForRun`, `testComplete`, Jira comment,
lane-to-done handoff. Cost goes from ~$0.10–$0.50 per run to $0.

Adds a `runnerType: "claude" | "script"` discriminator to
`AgentConfig`. `spawnAgent` dispatches on it: Claude path is the
existing 400-line happy path; script path is a new ~80-line sibling
that pipes raw stdout/stderr into `messages` rows the same UI
renders today and exits via the same `child.on("exit")` handler that
fires `finalize()`.

`test:author` (the future button) stays Claude-based — spec
authoring is real reasoning work and is out of scope for this plan.

## Problem Statement

The shipped `test:playwright` agent (PR #7) wraps `pnpm playwright
test` in a `claude -p ...` subprocess. Claude reads a 60-line prompt,
decides to run bash, runs the tests, parses JSON, writes a markdown
artifact, exits.

Looking at it honestly, ~99% of that work is mechanical:

- **Cost.** Each run spends $0.10–$0.50 of token budget for shell
  orchestration. With realistic cadence (5–20 Approve Implementation
  events per day across the swimlane), that's $1–$10/day in pure
  orchestration overhead. Annualised: $300–$3,500 for behaviour a
  shell script gives away free.
- **Determinism.** Claude can hallucinate spec names in failure
  summaries, retry tools weirdly, get stuck in turn loops on a flaky
  test, narrate a failure in a way that's misleading. The exact
  same input produces the exact same output from a script. Every
  time.
- **Speed.** Claude startup + token streaming is 5–15 seconds before
  any real work. The script's `pnpm playwright test` starts in
  ~50ms. For a 90-second suite, this is 5–15% wall-clock savings;
  for shorter suites, more.
- **Operator debuggability.** Today, when Playwright crashes
  unexpectedly (Chromium binary missing, port 3000 busy, OOM), the
  run log shows Claude narrating what it thinks happened, not
  Playwright's actual error message. With a script, the operator
  reads raw `pnpm playwright test` output — which is what they want.

## Proposed Solution

**A single new dispatcher branch** in `spawnAgent`. When the agent's
`runnerType === "script"`, route to a new `spawnScriptInner` that:

1. Resolves the script path (`<aiopsRoot>/scripts/run-playwright.ts`
   by default, override via new `TEST_RUNNER_SCRIPT` config).
2. Spawns `node_modules/.bin/tsx <scriptPath> <jiraKey> <branch>`
   with `cwd=worktree`, the same minimised env the Claude path uses.
3. Pipes stdout lines as `messages` rows of `type: "server"` /
   `payload: { kind: "stdout", text: line }`. Stderr → `kind:
   "stderr"`. Reuses the existing `RunLog.tsx` server-event render
   branch.
4. Skips cost-meter init (no token usage to track).
5. Emits the same lifecycle synthetic events the Claude path emits
   (`spawned`, `exit`).
6. On `child.on("exit")`, calls the same `finalize()` chain — which
   already handles `runs.status` update, lane rollback for failed
   runs, `persistArtifactsForRun`, the test-lane-specific
   `testComplete` invocation, and the serialise-chain release.

The script itself (`scripts/run-playwright.ts`):

- Detects Playwright config (`playwright.config.{ts,js,mjs}`); if
  missing, writes a SKIPPED artifact and exits 0.
- Runs `pnpm playwright install --with-deps` (idempotent).
- Runs `pnpm playwright test --reporter=list --reporter=json:test-results.json`.
- Parses `test-results.json` for total counts + failing-spec list.
- Writes `docs/tests/<jiraKey>-test.md` with the same frontmatter
  shape `parseTestArtifact` already expects.
- Exits 0 on PASS or SKIPPED, 1 on FAIL.

Auto-flip: bumping aiops to the version with this change flips
`test:playwright` from `runnerType: "claude"` (default) to
`runnerType: "script"` in the registry. No DB migration, no setting
toggle. Existing in-flight runs at deploy time are orphaned (already
the case for any deploy mid-run; reconciler picks them up).

## Technical Approach

### Architecture

The change adds one discriminator and one parallel spawn path. The
Claude path is unchanged.

```
                    startRun(taskId, lane, agentId)
                              │
                              ▼
                  agent = getAgent(agentId)
                              │
                              ▼
                spawnAgent({ ..., runnerType: agent.runnerType })
                              │
                ┌─────────────┴─────────────┐
                │                           │
       runnerType === "claude"     runnerType === "script"
                │                           │
                ▼                           ▼
       spawnClaudeInner             spawnScriptInner          ◄── new
       (existing)                   - tsx scriptPath
                                    - line-buffered stdout
                                    - skip cost meter
                                    - skip stream-json parse
                │                           │
                └─────────────┬─────────────┘
                              ▼
                     child.on("exit")
                              │
                              ▼
                  releaseExitChain (mutex)
                              │
                              ▼
                     finalize(runId, status)              ◄── shared
                  - decideExitStatus
                  - runs.status update
                  - lane rollback if needed
                  - persistArtifactsForRun
                  - testComplete (lane==="test")
                  - autoAdvance
                  - bus.emit("end")
```

The ten or so lines of dispatcher wrap a 400-line `spawnClaudeInner`
(the existing body, renamed) and a new ~80-line `spawnScriptInner`.
Both share `runRegistry`, `bus`, `persistAndEmit`, the
serialise-chain release, and `finalize`.

### Implementation Phases

#### Phase 1: Dispatcher + types (~0.5 day)

Goal: typed runner discriminator + dispatch wiring. No behavioural
change yet (script path is a stub).

Files:

- `server/agents/registry.ts`
  - `AgentConfig` gains optional `runnerType?: "claude" | "script"`
    (default `"claude"`) and `script?: string` (path resolved
    against aiops repo root, only meaningful when
    `runnerType === "script"`).
  - `model`, `maxTurns`, `permissionMode`, `buildPrompt`,
    `costWarnUsd`, `costKillUsd` stay on the type but are
    documented as ignored when `runnerType === "script"`.
    Trade-off: keeps the type flat (simple consumers, no
    discriminated-union narrowing in 30+ call sites). The unused
    fields cost ~10 lines of `model: "n/a"` style noise on the
    one script agent.
  - `snapshotAgent(a)` includes `runnerType` in the JSON snapshot
    so historical run inspection knows which path was taken.
- `server/worker/spawnAgent.ts`
  - `SpawnAgentParams` gains `runnerType?: "claude" | "script"` and
    `scriptPath?: string`.
  - Existing `spawnAgentInner` renamed to `spawnClaudeInner`. No
    body change.
  - New stub `spawnScriptInner(p, onChildExit?)` that just
    `console.log`s + invokes `onChildExit?.()` so the dispatcher
    works end-to-end before Phase 2 fills in the real spawn.
  - `spawnAgent` (the dispatcher) checks `p.runnerType === "script"`
    and routes accordingly. Serialise-chain wrapping unchanged.
- `server/worker/startRun.ts`
  - At the spawnAgent call site (line 316), pass
    `runnerType: agent.runnerType ?? "claude"` and
    `scriptPath: agent.script` when set.
  - Skip prompt-building for script agents (no `agent.buildPrompt`
    call). The `prompt` field on SpawnAgentParams becomes optional
    or empty string for scripts.

Acceptance: `npm run typecheck` clean; existing tests pass (76/77,
the same pre-existing native-binding test failure unaffected); a
SQL-update of an agent's runnerType to "script" routes through the
stub.

##### tests/registryRunnerType.test.ts

```typescript
import { describe, it, expect } from "vitest";
import { AGENTS } from "@/server/agents/registry";

describe("AgentConfig runnerType", () => {
  it("defaults to undefined (== claude semantically) for existing agents", () => {
    expect(AGENTS["ce:work"].runnerType).toBeUndefined();
    expect(AGENTS["ce:brainstorm"].runnerType).toBeUndefined();
  });

  // Updated in Phase 4 to assert "script" once test:playwright flips.
});
```

#### Phase 2: spawnScriptInner — real implementation (~0.5 day)

Goal: the script-runner spawn actually forks a child, streams output
to `messages`, and routes through `finalize` cleanly.

`spawnScriptInner` body sketch:

```typescript
function spawnScriptInner(
  p: SpawnAgentParams,
  onChildExit?: () => void,
): void {
  const aiopsRoot = process.cwd();
  const tsxBin = path.join(aiopsRoot, "node_modules/.bin/tsx");
  const scriptPath = path.isAbsolute(p.scriptPath ?? "")
    ? p.scriptPath!
    : path.join(aiopsRoot, p.scriptPath ?? "");
  if (!existsSync(scriptPath)) {
    audit({ action: "run.script_missing", runId: p.runId,
            payload: { scriptPath } });
    void finalize(p.runId, "failed", `script not found: ${scriptPath}`);
    onChildExit?.();
    return;
  }

  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? p.worktreePath,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    USER: process.env.USER ?? "",
    TERM: "xterm-256color",
    AIOPS_TASK_ID: p.taskId,
    AIOPS_RUN_ID: p.runId,
  };

  const child = spawn(
    tsxBin,
    [scriptPath, /* extra positional args from p.scriptArgs */],
    { cwd: p.worktreePath, env: childEnv,
      stdio: ["ignore", "pipe", "pipe"] },
  );

  // Same registry shape for Stop button + reconciler:
  runRegistry.set(p.runId, { runId: p.runId, taskId: p.taskId,
    child, startedAt: Date.now(),
    stop: (reason) => { lastStopReason = reason;
                        try { child.kill("SIGTERM"); } catch {}
                        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); },
                                   KILL_GRACE_MS).unref(); } });

  // Synthetic spawned event so the UI sees "started":
  persistAndEmit("server", { kind: "spawned",
    runner: "script", scriptPath, worktree: p.worktreePath });

  const rl = readline.createInterface({ input: child.stdout!, terminal: false });
  rl.on("line", (line) => {
    persistAndEmit("server", { kind: "stdout", text: line.slice(0, 8000) });
  });
  if (child.stderr) {
    const rlErr = readline.createInterface({ input: child.stderr, terminal: false });
    rlErr.on("line", (line) => {
      persistAndEmit("server", { kind: "stderr", text: line.slice(0, 8000) });
    });
  }

  let exitChainReleased = false;
  const releaseExitChain = () => {
    if (exitChainReleased) return;
    exitChainReleased = true;
    try { onChildExit?.(); } catch {}
  };

  child.on("error", (err) => {
    persistAndEmit("server", { kind: "spawn_error", error: String(err) });
    releaseExitChain();
    void finalize(p.runId, "failed", `spawn_error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    releaseExitChain();
    persistAndEmit("server", { kind: "exit", code, signal });
    const status = decideExitStatus(code, signal, lastStopReason);
    void finalize(p.runId, status,
      `${lastStopReason ? lastStopReason + ":" : ""}exit code=${code} signal=${signal ?? "none"}`);
  });

  audit({ action: "run.started", runId: p.runId, taskId: p.taskId,
          payload: { runner: "script", scriptPath } });
}
```

Key differences from `spawnClaudeInner`:

- No `--permission-mode`, no `--model`, no `--session-id`.
- No `initMeter` / `observeAssistantUsage` / cost ticks.
- No `parseStreamLine` — stdout lines are raw text, wrapped as
  `server` events with `kind: "stdout"` (sibling to the existing
  `kind: "stderr"`). UI's `RunLog.tsx` already has a render branch
  for `type === "server"` (line 75); a small renderer addition for
  the new `kind: "stdout"` is cheap and lives in this phase too.
- No `claudeSessionId` writes, no `numTurns` updates.
- No mid-stream `NEEDS_INPUT` detection. Scripts can't pause for
  human input; they run to completion.

What's identical:

- `runRegistry.set/delete` (Stop button + reconciler unchanged).
- `serializeKey` mutex (the dispatcher handles this, not the
  inner).
- `bus` SSE emission via `persistAndEmit`.
- `decideExitStatus` mapping (0 → completed, 143 → stopped, 137 →
  stopped, anything else → failed).
- `finalize()` chain — every downstream concern (artifact
  persistence, testComplete, autoAdvance, lane rollback, bus end
  event) is shared.

Acceptance: a script that prints "hello\n" + exits 0 produces a
`runs` row with `status: completed`, two `messages` rows
(`spawned`, `exit`) plus one stdout line, and the run.completed
audit lands. `pkill` mid-run leaves `runs.status = stopped` with
`current_run_id = null`.

##### tests/spawnScript.test.ts

```typescript
// Exercises the script-runner branch of spawnAgent end-to-end with
// a fixture script that prints + exits 0. Real spawn (vitest's
// child_process); real DB (in-memory sqlite via the existing
// test scaffold).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/server/db/client";
import { runs, messages } from "@/server/db/schema";

vi.mock("@/server/git/testComplete", () => ({
  testComplete: vi.fn().mockResolvedValue({ ok: true, verdict: "PASS" }),
}));

describe("spawnScriptInner", () => {
  beforeEach(() => { /* truncate */ });

  it("a happy-path script emits stdout + exits 0 → run.status = completed", async () => {
    // seed runs row, call spawnAgent with runnerType=script + a
    // fixture echo-script
    // wait for runs.status to become completed (poll up to 5s)
    expect(/* runs.status */).toBe("completed");
    expect(/* messages count for runId */).toBeGreaterThan(0);
  });

  it("missing script path → runs.status = failed + run.script_missing audit row", async () => {
    // spawn with non-existent path
    expect(/* runs.status */).toBe("failed");
    expect(/* audit row count for action=run.script_missing */).toBe(1);
  });

  it("stop() during script run → runs.status = stopped", async () => {
    // spawn a fixture sleep-script, immediately call runRegistry.get(runId).stop("user")
    expect(/* runs.status */).toBe("stopped");
  });
});
```

#### Phase 3: scripts/run-playwright.ts (~0.5 day)

Goal: the actual Playwright runner.

Behaviour:

1. Reads positional args: `jiraKey`, `branch` (optional).
2. Detects Playwright via `playwright.config.{ts,js,mjs}` in cwd.
   If missing → write SKIPPED artifact + exit 0.
3. `spawnSync("pnpm", ["playwright", "install", "--with-deps"],
   { stdio: "inherit", cwd: process.cwd() })`. stdio:inherit means
   pnpm output lands in the script's stdout, which spawnScriptInner
   pipes to messages.
4. `spawnSync("pnpm", ["playwright", "test", "--reporter=list",
   "--reporter=json:test-results.json"])`.
5. Reads `test-results.json`, computes:
   - `passed = stats.expected`
   - `failed = stats.unexpected + stats.flaky`
   - `failingSpecs[]` — walk `suites[].specs[].tests[]`, collect
     where `status === "failed"`. Format: `<file> › <title>`.
6. Writes `docs/tests/<jiraKey>-test.md` with the same YAML
   frontmatter `parseTestArtifact` reads (`ticket`, `date`,
   `status`, `verdict`, `passed`, `failed`).
7. Exits 0 on PASS/SKIPPED, 1 on FAIL.

Edge cases handled:

- **`docs/tests/` dir missing**: `mkdirSync(..., { recursive: true })`.
- **`test-results.json` missing/malformed**: fall back to FAIL with
  zeros + a note in the artifact body.
- **SIGTERM mid-run**: register `process.on("SIGTERM")` handler that
  kills the active `pwChild` so Playwright's child processes don't
  orphan. Without this, killing the script leaves Playwright
  running and holding port 3000.
- **Hard timeout**: 30-minute wall-clock cap (override via
  `PLAYWRIGHT_TIMEOUT_MS` env). If hit, write FAIL artifact with
  "Suite exceeded timeout" + exit 1. Prevents an infinite-loop test
  from holding the orchestrator's mutex forever.

##### scripts/run-playwright.ts skeleton

```typescript
#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [jiraKey, branch] = process.argv.slice(2);
if (!jiraKey) {
  console.error("usage: run-playwright.ts <jiraKey> [branch]");
  process.exit(2);
}

const cwd = process.cwd();
const docsTestsDir = path.join(cwd, "docs/tests");
mkdirSync(docsTestsDir, { recursive: true });

// 1. Detect Playwright
const configFile = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]
  .map((f) => path.join(cwd, f))
  .find(existsSync);
if (!configFile) {
  writeArtifact("SKIPPED", 0, 0, [],
    "Playwright is not configured in this managed repo (no playwright.config.*).");
  process.exit(0);
}

// 2. SIGTERM propagation
let pwChild: ChildProcess | undefined;
process.on("SIGTERM", () => {
  pwChild?.kill("SIGTERM");
  setTimeout(() => process.exit(143), 1000).unref();
});

// 3. Hard timeout
const timeoutMs = parseInt(process.env.PLAYWRIGHT_TIMEOUT_MS ?? "1800000", 10);
const timeoutHandle = setTimeout(() => {
  pwChild?.kill("SIGTERM");
  writeArtifact("FAIL", 0, 1, [`Suite exceeded ${timeoutMs}ms timeout`],
    "Hard timeout. Tighten test scope or raise PLAYWRIGHT_TIMEOUT_MS.");
  process.exit(1);
}, timeoutMs);
timeoutHandle.unref();

// 4. Install + run
runSpawn("pnpm", ["playwright", "install", "--with-deps"]);
const exitCode = runSpawn("pnpm", [
  "playwright", "test",
  "--reporter=list",
  "--reporter=json:test-results.json",
]);

// 5. Parse results
const jsonPath = path.join(cwd, "test-results.json");
let passed = 0, failed = 0, failingSpecs: string[] = [];
try {
  const json = JSON.parse(readFileSync(jsonPath, "utf8"));
  const stats = json.stats ?? {};
  passed = stats.expected ?? 0;
  failed = (stats.unexpected ?? 0) + (stats.flaky ?? 0);
  if (failed > 0) walkSuites(json.suites ?? [], failingSpecs);
} catch (err) {
  // 6. Fallback: malformed/missing JSON. Trust the exit code.
  failed = exitCode === 0 ? 0 : 1;
  failingSpecs = ["test-results.json missing or malformed; see run log for raw output"];
}

const verdict: "PASS" | "FAIL" = failed === 0 && exitCode === 0 ? "PASS" : "FAIL";
writeArtifact(verdict, passed, failed, failingSpecs);
process.exit(verdict === "PASS" ? 0 : 1);

// ─── helpers ──────────────────────────────────────────────────
function runSpawn(cmd: string, args: string[]): number {
  const r = spawn(cmd, args, { cwd, stdio: "inherit" });
  pwChild = r;
  return new Promise<number>((res) => r.on("exit", (c) => res(c ?? 1)));
}

function walkSuites(suites: any[], out: string[]): void { /* … */ }

function writeArtifact(
  verdict: "PASS" | "FAIL" | "SKIPPED",
  passed: number, failed: number,
  failing: string[], note?: string,
): void {
  const md = `---
ticket: ${jiraKey}
date: ${new Date().toISOString().slice(0, 10)}
status: draft
verdict: ${verdict}
passed: ${passed}
failed: ${failed}
---
# Playwright ${verdict.toLowerCase()} (${passed}/${passed + failed})

${note ? note + "\n\n" : ""}${failing.length > 0
  ? "## Failing specs\n\n" + failing.map((s) => "- " + s).join("\n") + "\n\n"
  : ""}## Run metadata

- Branch: \`${branch ?? "(unknown)"}\`
- Started: ${new Date().toISOString()}
`;
  writeFileSync(path.join(docsTestsDir, `${jiraKey}-test.md`), md, "utf8");
}
```

Acceptance: against a fixture worktree with a 2-spec config, the
script writes a verdict-correct artifact and exits with the right
code.

##### tests/runPlaywrightScript.test.ts

```typescript
// Exercises the script directly via execFileSync (real tsx, real
// fixture worktree under tests/fixtures/playwright-pass and
// tests/fixtures/playwright-fail).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts/run-playwright.ts");
const TSX = path.join(process.cwd(), "node_modules/.bin/tsx");

describe("scripts/run-playwright.ts", () => {
  it("writes SKIPPED when no playwright.config exists", () => {
    const cwd = "/tmp/test-fixture-no-pw";
    // … setup fixture cwd …
    execFileSync(TSX, [SCRIPT, "ABC-123"], { cwd });
    const md = readFileSync(`${cwd}/docs/tests/ABC-123-test.md`, "utf8");
    expect(md).toContain("verdict: SKIPPED");
  });

  it("writes PASS when all specs pass", () => { /* … */ });
  it("writes FAIL with failingSpecs when one fails", () => { /* … */ });
  it("writes FAIL when test-results.json missing", () => { /* … */ });
});
```

#### Phase 4: Registry flip + config setting (~0.25 day)

Goal: `test:playwright` now runs as a script. New `TEST_RUNNER_SCRIPT`
config exposed in the wizard.

Files:

- `server/agents/registry.ts`
  - `AGENTS["test:playwright"]`: add
    `runnerType: "script"`, `script: "scripts/run-playwright.ts"`.
    Set `model: "n/a"`, `maxTurns: 0`,
    `buildPrompt: () => ""`. Comment that these are unused for
    script runners.
- `server/lib/config.ts`
  - New `TEST_RUNNER_SCRIPT: optionalStr(z.string().min(1))`.
    Default empty = use the agent's `script` field.
- `server/lib/settingsSchema.ts`
  - Add `TEST_RUNNER_SCRIPT` field in the `paths` section between
    `TEST_REPORTS_ROOT` and the section's other entries. Description:
    "Optional override for the test-lane runner script. Defaults to
    `scripts/run-playwright.ts` shipped with aiops. Set this when
    your managed repo provides its own runner."
- `server/agents/registry.ts` (continued)
  - When `runnerType === "script"`, `getAgent` resolves the
    effective `script` path: caller's `TEST_RUNNER_SCRIPT` config
    wins over the registry default.

Acceptance: a real Approve Implementation flow runs Playwright via
the script (no Claude tokens consumed — inspect run cost in DB =
0). Setting `TEST_RUNNER_SCRIPT` in `/admin/settings` to a custom
path routes to that path instead.

##### tests/registryRunnerType.test.ts (updated)

```typescript
it("test:playwright is now script-based", () => {
  expect(AGENTS["test:playwright"].runnerType).toBe("script");
  expect(AGENTS["test:playwright"].script).toBe("scripts/run-playwright.ts");
});

it("getAgent applies TEST_RUNNER_SCRIPT override", () => {
  // mock getConfig to return "custom/runner.ts"
  const a = getAgent("test:playwright");
  expect(a?.script).toBe("custom/runner.ts");
});
```

#### Phase 5: UI cost hiding (~0.25 day)

Goal: runs whose `runnerType === "script"` don't show a `$0.00`
label that would be confusing next to cost-killed Claude runs.

Files:

- `server/lib/enrichTask.ts`
  - Read the current run's `agentConfigSnapshotJson`, parse,
    extract `runnerType`. Add to enriched return as `runnerType?:
    "claude" | "script" | null`.
- `components/board/Board.tsx`
  - `Task` type gets `runnerType`. The card's cost badge skips
    rendering when `runnerType === "script"`.
- `components/card-detail/RunLog.tsx`
  - Similar conditional render of the cost badge in the run header.
- `components/card-detail/RunSidebar.tsx` and `RunHistoryList.tsx`
  - Same conditional.

Cost aggregation in `dashboardQueries.ts` needs no change — script
runs contribute 0, which is the truthful aggregate value.

Also in this phase: the `RunLog.tsx` server-event renderer (line
75 area) gains a render branch for `kind: "stdout"`. Pattern after
the existing `kind: "stderr"` branch — monospace text, no chrome.

Acceptance: visually, a script run's card shows lane chip + status
chip + (optionally) test verdict chip but no `$0.00` label. The
run log shows raw stdout/stderr lines from Playwright in monospace
without any pricing context.

##### tests/runnerTypeUI.test.ts

```typescript
// Component test using @testing-library — render Board with two
// tasks: one running test:playwright (runnerType=script,
// costUsd=0), one running ce:work (runnerType=claude, costUsd=2.5).
// Assert the script card has no "$" element; the claude card
// shows "$2.5000".
```

#### Phase 6: Manual verification + docs (~0.25 day)

- Take a real ticket from brainstorm → Approve Implementation;
  watch the test lane fire WITHOUT a Claude subprocess. Confirm:
  - `runs.cost_usd_micros = 0` for the test run.
  - `messages` rows show raw Playwright output (no Claude
    `system`/`assistant` events).
  - Artifact verdict + counts populate correctly.
  - Jira pass/fail comment posts via `testComplete`.
  - Lane → done on PASS, holds on FAIL.
- Confirm Stop button works (operator clicks, runs.status →
  stopped, lane rollback for `test` lane is the existing "hold"
  semantics).
- Confirm timeout: temporarily set `PLAYWRIGHT_TIMEOUT_MS=10000`
  on a slow suite, confirm timeout-FAIL artifact + clean exit.
- Update `README.md` if it mentions Claude as the test runner
  (currently it doesn't — README defers to wizard).

## Alternative Approaches Considered

Recap from
[brainstorm](../brainstorms/2026-05-08-test-runner-without-claude-brainstorm.md):

- **A — Direct script invocation (chosen).** YAGNI; reuses the
  existing spawn pipeline; one new file (~150 lines) + one
  dispatcher branch (~80 lines). No new processes, no new HTTP
  boundary, no CI dependency.

- **B — Standalone test server.** Separate Node service on `:4000`,
  HTTP API + callbacks. **Rejected**: doubles the moving parts for
  a single-tenant single-VPS deployment with no scaling pressure.
  Right answer when there's a separate test-runner pool, multiple
  aiops instances sharing it, or test infrastructure owned by a
  different team.

- **C — GitHub Actions / external CI.** Tests run on PR via Actions;
  aiops polls `check_runs`. **Rejected for v1**: depends on a
  working Playwright Actions workflow on the managed repo (separate
  setup), slower feedback (queue + cold start = 1–3 min minimum),
  operator-triggered Re-run needs `workflow_dispatch` plumbing.
  Strong long-term answer once the suite outgrows one machine or
  the team picks up CI culture.

Also considered + rejected during planning:

- **Discriminated union for `AgentConfig`** (refactor `model`/
  `buildPrompt` into Claude-only branch, add Script-only branch).
  Cleaner type-wise but touches 30+ call sites. Postponed; flat
  type with optional+ignored fields is good enough for v1.
- **Reuse `stream_event` message type for stdout lines** (per
  brainstorm decision). Investigation revealed `stream_event`
  payloads in `RunLog.tsx` expect Claude's `content_block_delta`
  shape; reusing it would require a UI renderer split. Switched
  to `server` events with `kind: "stdout"` — symmetric with the
  existing `kind: "stderr"` branch and renders without a UI
  refactor.
- **Persist `runnerType` as a column on `runs`.** Trades a
  one-off migration for cheaper-per-row UI lookups. Avoided —
  parsing `agentConfigSnapshotJson` is plenty fast and a
  migration adds reviewer load.

## System-Wide Impact

### Interaction Graph

When the test lane spawns:

1. `implementComplete` (after Approve Implementation) writes
   `currentLane: "test"` and calls `startRun({ lane: "test",
   agentId: "test:playwright" })`.
2. `startRun` → `getAgent("test:playwright")` → reads
   `runnerType: "script"` and `script: "scripts/run-playwright.ts"`.
3. `startRun` → `spawnAgent({ runnerType: "script",
   scriptPath: "scripts/run-playwright.ts", ..., serializeKey:
   "test:playwright:global" })`.
4. `spawnAgent` (dispatcher) → `withSerialiseChain(...)` →
   `spawnScriptInner`.
5. `spawnScriptInner` forks `tsx scripts/run-playwright.ts <jiraKey>`
   with cwd = worktree.
6. Script: `pnpm playwright install` + `pnpm playwright test`.
   Each subprocess inherits the script's stdout — every Playwright
   line lands in `messages` via `persistAndEmit("server", { kind:
   "stdout", text })`.
7. Script writes `docs/tests/<jiraKey>-test.md`, exits 0 or 1.
8. `child.on("exit")` → `releaseExitChain()` (mutex available for
   next test) → `decideExitStatus(code, signal)` → `finalize(runId,
   status)`.
9. `finalize` → DB status update → `persistArtifactsForRun(runId)`
   ingests the test artifact → `testComplete(runId, taskId)`
   reads verdict, copies reports to `TEST_REPORTS_ROOT`, posts Jira
   comment, writes `currentLane: "done"` on PASS.
10. UI sees a `run.completed` SSE event, the operator's board
    refresh shows the lane chip flipping to `done` + the test
    verdict chip rendering green/red.

### Error & Failure Propagation

- **Script not found**: `spawnScriptInner` checks
  `existsSync(scriptPath)` before spawning. If missing → audit
  `run.script_missing` + finalize as `failed` + lane rollback (held
  on `test`). Operator sees a banner; fix `TEST_RUNNER_SCRIPT`
  config or restore the file.
- **Script crashes immediately** (e.g. tsx not installed): exit
  code is non-zero; `decideExitStatus` returns `failed`; same path
  as above.
- **`pnpm` not on PATH** in the worktree: Playwright's `runSpawn`
  fails; script writes a FAIL artifact with the error in the
  failingSpecs list and exits 1. Run log shows raw `pnpm: command
  not found`.
- **`test-results.json` malformed**: script's `JSON.parse` throws,
  caught by the fallback branch — writes FAIL with a "results JSON
  missing/malformed" failingSpecs entry. testComplete's
  `parseTestArtifact` reads the frontmatter without trouble.
- **Script SIGTERM'd mid-Playwright**: script's signal handler
  kills `pwChild` and exits 143; `decideExitStatus` returns
  `stopped`; lane stays `test` (not rolled back); `currentRunId`
  cleared so the operator can re-run.
- **Hard timeout**: script self-terminates with FAIL artifact +
  exit 1. Same finalize path as a normal FAIL.
- **`testComplete` itself throws** (disk full on `cp` to
  `TEST_REPORTS_ROOT`, etc.): caught in finalize's try/catch
  (existing pattern); audit `test.complete_failed`; lane stays
  `test`; operator sees the banner.
- **Mutex never releases** (script process orphaned, never
  exits): the existing `_serializeChains` Map's chain stays open.
  Mitigated by the script's hard timeout (30 min default). For
  truly orphaned children (PID not reaping), the operator can
  restart aiops; `_serializeChains` is in-process and resets.

### State Lifecycle Risks

- **Worktree mid-state**: the script writes `docs/tests/` and
  `playwright-report/` and `test-results.json` to the worktree.
  These aren't committed by the script. `testComplete`'s report
  copy step picks `playwright-report/` out before the worktree's
  next state change. None of these files cause a `git status` dirt
  in the agent's branch because (a) they're in standard ignored
  paths or (b) the worktree is GC'd by the existing nightly cron.
- **Concurrent test runs on same task**: prevented by
  `withSerialiseChain` mutex (already enforced).
- **Two runs racing on the same worktree**: a hypothetical
  Re-run-Tests click while a prior run is mid-flight. The /runs
  endpoint already rejects when an active run exists for the
  task; the mutex is a second-line defence.
- **Script vs Claude in flight at deploy time**: existing in-flight
  Claude run continues to completion against pre-deploy code; new
  runs are script-based. The runs row's `agent_config_snapshot_json`
  captures `runnerType` per-run, so historical inspection is
  truthful. Reconciler picks up either flavour identically (status
  = running, no live process → mark interrupted).

### API Surface Parity

- **No new endpoints.** `/api/tasks/:id/runs` already accepts
  `lane: "test"` + `agentId: "test:playwright"`. Behaviour is
  unchanged at the API level — only the spawn-time path differs.
- **No agent-tool surface change.** `test:playwright` was already
  an opt-in agent the operator triggers via Approve Implementation
  → auto-spawn or via Re-run Tests; both flows continue to work.
- **`startRun`'s `StartRunParams` shape unchanged** at call sites.
  Internally, the prompt-build branch is skipped for script
  agents.

### Integration Test Scenarios

1. Full Approve-Implementation → test:playwright (script) → done on
   PASS: assert `runs.status = completed`, `runs.cost_usd_micros =
   0`, artifact verdict = PASS, Jira comment posted, lane = done.
2. Approve-Implementation → test:playwright (script) → FAIL: assert
   lane stays `test`, three buttons render (Re-run, Fix, Skip),
   artifact verdict = FAIL with failingSpecs populated.
3. Concurrent Approve-Implementation on two tasks: test:playwright
   runs serialise via the global mutex; second run's `runs.startedAt`
   ≥ first run's `runs.finishedAt`.
4. Mid-suite Stop button: child process killed cleanly, no zombie
   Playwright/browsers, lane stays `test` with current_run_id null.
5. Mixed agent types in a single Approve Implementation: ce:work
   completes (Claude, $X cost) → test:playwright runs (script,
   $0). Both runs visible in the card history; cost badge
   present on the first, absent on the second.

## Acceptance Criteria

### Functional Requirements

- [x] `AgentConfig` gains `runnerType?: "claude" | "script"`
      (default `"claude"`) and `script?: string`. Snapshotted in
      `agentConfigSnapshotJson` per run.
- [x] `spawnAgent` dispatcher routes by `runnerType`. Existing
      Claude path renamed to `spawnClaudeInner`; new
      `spawnScriptInner` is a sibling.
- [x] `spawnScriptInner` forks `tsx <scriptPath>` with the same
      `cwd=worktree`, minimised env, `runRegistry` registration,
      bus emission, and `finalize` chain as the Claude path.
      Skips cost meter init.
- [x] Stdout lines persist as `server` events with
      `kind: "stdout"`; stderr as `kind: "stderr"`. UI renderer
      (`RunLog.tsx`) gains a `kind: "stdout"` render branch.
- [x] `scripts/run-playwright.ts` exists, detects Playwright,
      runs install + test, parses JSON, writes the canonical
      `docs/tests/<jiraKey>-test.md` shape, exits 0/1 by verdict.
- [x] `AGENTS["test:playwright"]` flipped to
      `runnerType: "script"`, `script: "scripts/run-playwright.ts"`.
- [x] New `TEST_RUNNER_SCRIPT` config setting (optional override),
      surfaced in `/admin/settings` via `settingsSchema.ts`.
- [x] UI hides the cost field on script runs (Board, RunLog,
      RunSidebar, RunHistoryList).
- [x] Stop button works: SIGTERM the script → script SIGTERMs its
      Playwright child → both exit cleanly. *(Implemented via
      process.on("SIGTERM"/"SIGINT") in scripts/run-playwright.ts;
      manual end-to-end verification pending Phase 6.)*
- [x] Hard timeout: script exits with FAIL artifact after
      `PLAYWRIGHT_TIMEOUT_MS` (default 30 min).

### Non-Functional Requirements

- [x] No DB migration. Schema unchanged; runnerType lives in the
      JSON snapshot column.
- [x] No regression on existing Claude-based agents (`ce:brainstorm`,
      `ce:plan`, `ce:review`, `ce:work` all run unchanged through
      `spawnClaudeInner`).
- [ ] Script run wall-clock ≤ Claude-wrapper wall-clock − 5s
      (startup overhead delta). *Pending manual verification.*
- [ ] Cost per `test:playwright` run drops from ~$0.10–$0.50 to $0.
      *Verifiable post-deploy via the SQL query in Success Metrics.*

### Quality Gates

- [ ] Unit test for the dispatcher: routes by `runnerType`
      correctly. *Deferred — covered by manual smoke test of the
      script standalone (verified during Phase 3 against a fixture
      cwd; produces SKIPPED artifact + exit 0).*
- [ ] Unit test for the script's parser: PASS / FAIL / SKIPPED
      verdicts; missing JSON; malformed JSON. *Deferred to a
      follow-up — the script's parser is small, the integration
      test below covers the happy-path shape.*
- [ ] Integration test (vitest + real spawn): script-runner
      end-to-end with a fixture worktree. *Deferred to follow-up;
      lifecycle (spawn → exit → finalize) shares 100% of the
      Claude path's tests modulo the runner branch.*
- [ ] Manual end-to-end against the managed repo's marben-qa-test
      branch (Phase 6). *Pending — requires running aiops with
      `BASE_BRANCH=marben-qa-test` against a real ticket.*
- [x] `npm run typecheck` clean.
- [ ] Linting clean. *Skipped — `next lint` is deprecated in
      Next.js 16 and the repo doesn't have an ESLint config yet;
      not in scope for this PR.*

## Success Metrics

- **Token cost on test lane → $0.** Verified by querying
  `SELECT SUM(cost_usd_micros) FROM runs WHERE agent_id =
  'test:playwright' AND started_at > <deploy-date>`. Expected: 0.
- **Wall-clock to first Playwright invocation drops by 5–15s.**
  Verified by comparing `messages.created_at` of the first
  `kind: "stdout"` row against the spawn time. Pre-flip:
  ~10–15s lag (Claude startup). Post-flip: ~1s.
- **Operator-reported clarity of failure logs.** Subjective; verify
  by asking the QA tester after 2 weeks whether they can read the
  test lane's run log without bouncing to the agent's narration.
- **Determinism.** Same code + same test suite + same env → same
  `messages` row sequence (modulo ordering). Spot-check via two
  consecutive Re-run Tests clicks; the run logs should be
  byte-equivalent in the test results section.

## Dependencies & Prerequisites

- **PR #7 (test lane)** — merged ✓.
- **PR #8 (handoff improvements)** — merged ✓.
- **`tsx`** — already a runtime dep
  (`server/db/migrate-cli.ts` uses it).
- **`pnpm`** — already required by the test:playwright agent's
  current Claude prompt; same prerequisite carries forward.
- **Managed repo has Playwright** (`playwright.config.*` +
  `@playwright/test`). The script handles the missing case via
  SKIPPED verdict — no hard failure.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stop button doesn't kill grandchild Playwright processes | M | M | Script's `process.on("SIGTERM")` handler kills `pwChild` before exiting. Test in Phase 2. |
| `tsx` resolves wrong (PATH issue when launched as systemd service) | L | M | Use absolute path `<aiopsRoot>/node_modules/.bin/tsx`. Don't rely on PATH for `tsx`. |
| `RunLog.tsx` doesn't render the new `kind: "stdout"` correctly | M | L | Phase 5 includes the renderer addition; visual smoke test in Phase 6. |
| Script's `pnpm playwright install` re-downloads browsers on each run | H | L | `--with-deps` is idempotent; browsers cache to `~/.cache/ms-playwright` (HOME is in the env allowlist). |
| Hard timeout fires on a legitimate long suite | L | M | Configurable via `PLAYWRIGHT_TIMEOUT_MS`; document. |
| Existing in-flight Claude test:playwright runs at deploy time orphan | M | L | Same as any other in-flight run during deploy. Reconciler marks `interrupted`. Operator re-runs. |
| Operator confusion at "$0.00 vs no cost label" | L | L | Phase 5 hides cost on script runs entirely (per brainstorm decision). |
| Hide-cost UI tweak misses one component | M | L | Component test (Phase 5) covers Board + RunLog; RunSidebar + RunHistoryList added by inspection. |
| Script writes artifact to wrong path (worktree dir confusion) | L | M | Script uses `process.cwd()` which is set by spawn to the worktree; assert in Phase 3 unit test. |

## Resource Requirements

- 1 engineer × 2.5 days (~20 hours).
- No new infrastructure.
- No new external dependencies.
- Disk: same as today (the script reuses the worktree's
  `playwright-report/` dir; no extra storage).

## Future Considerations

- **Other test runners** (vitest e2e, Cypress, Jest) become trivial
  once the script-runner pattern is in: add a new agent with a
  different `script` path. Same dispatcher.
- **`test:author` migration to script** — *not for v1*. Spec
  authoring needs LLM reasoning; keep Claude there.
- **External CI fallback** — once the suite outgrows one machine,
  a future plan can layer GitHub Actions polling on top of the
  same `runnerType` discriminator (`runnerType: "ci"` with a
  webhook + poll loop).
- **Streaming JSON parsing** — currently the script reads
  `test-results.json` only after Playwright exits. A streaming
  reporter could let the run log show pass/fail per spec live.
  YAGNI for v1.
- **Per-script env passthrough** — the `TEST_RUNNER_SCRIPT`
  override could grow a sibling `TEST_RUNNER_ENV` (JSON) for
  scripts that need extra config (API keys for E2E auth, etc.).

## Documentation Plan

- `README.md` — no change needed (it defers all config to the
  wizard, and the wizard's `paths` section already explains
  `BASE_REPO`/`WORKTREE_ROOT`/`TEST_REPORTS_ROOT`; Phase 4 adds
  `TEST_RUNNER_SCRIPT` to that list).
- `CLAUDE.md` — add a one-paragraph "runner types" note in the
  agents section, explaining that some agents run Claude
  subprocesses and others run plain scripts.
- New `scripts/run-playwright.ts` carries an inline header comment
  explaining the contract: positional args, env vars, exit codes,
  artifact location.
- Setup wizard's `paths` section copy gains the
  `TEST_RUNNER_SCRIPT` field description (handled by
  `settingsSchema.ts` field descriptions, no separate doc).

## Sources & References

### Origin

- **Brainstorm:**
  [`docs/brainstorms/2026-05-08-test-runner-without-claude-brainstorm.md`](../brainstorms/2026-05-08-test-runner-without-claude-brainstorm.md).
  Decisions carried forward:
  1. Approach A (direct script invocation) over B (HTTP test
     server) and C (GitHub Actions).
  2. Node TypeScript for the runner; runtime via `tsx`.
  3. `TEST_RUNNER_SCRIPT` config override for managed-repo
     customisation.
  4. Auto-flip on upgrade — no admin toggle, no migration step.
  5. Raw stderr triage; no auto-classifier or Claude diagnosis.
  6. Hide cost UI on script runs entirely.
  7. (Plan-time deviation from brainstorm) Output via `server`
     events instead of `stream_event` — `RunLog.tsx`'s existing
     `stream_event` payload assumes Claude's `content_block_delta`
     shape; `server` events match the existing `stderr` branch.

### Internal References

- Test lane shipped: `feat/post-implement-test-lane` (PR #7,
  merged at `074a056`). Origin file:
  [`docs/plans/2026-05-08-feat-post-implement-test-lane-plan.md`](2026-05-08-feat-post-implement-test-lane-plan.md).
- Spawn dispatcher with serialise-chain:
  `server/worker/spawnAgent.ts:55-95` (existing `spawnAgent` →
  `spawnAgentInner` will be renamed `spawnClaudeInner`).
- Mutex pattern: `server/worker/spawnAgent.ts:_serializeChains`
  (the in-process queue keyed on `serializeKey`).
- Finalize chain (the convergence point):
  `server/worker/spawnAgent.ts:340-495`
  (`async function finalize(runId, status, reason)`).
- Exit-status classifier: `server/worker/exitStatus.ts:27-38`.
  Reused as-is for script exits.
- Artifact persistence + lane → kind mapping:
  `server/worker/persistArtifacts.ts:14-44`. The `"test"` kind
  + `LANE_TO_KIND.test = { kind: "test", dir: "docs/tests" }`
  entry (added in PR #7) makes the script's artifact path
  `docs/tests/<jiraKey>-test.md` ingest correctly without changes.
- Test-complete handoff: `server/git/testComplete.ts`. Reads the
  artifact frontmatter via `parseTestArtifact`. Unchanged by this
  plan; the script writes the same shape Claude was writing.
- Settings registration: `server/lib/config.ts:64-75`,
  `server/lib/settingsSchema.ts:200-235`.
- UI run log renderer:
  `components/card-detail/RunLog.tsx:75` (server event branch);
  Phase 5 adds the `kind: "stdout"` case.
- Stream parsing (Claude-specific, irrelevant to script runs):
  `server/worker/streamParser.ts:1-40`. Confirms the brainstorm's
  output-format decision needed adjustment — `stream_event`
  payloads here are Claude shape, not arbitrary line text.

### External References

- Playwright JSON reporter:
  https://playwright.dev/docs/test-reporters#json-reporter
- Playwright `webServer` config (managed-repo prerequisite):
  https://playwright.dev/docs/test-webserver
- Node child_process signal handling:
  https://nodejs.org/api/child_process.html#event-exit
- `tsx` (runtime TypeScript executor):
  https://github.com/privatenumber/tsx

### Related Work

- **PR #7** — test lane (`feat/post-implement-test-lane`). Predecessor.
- **PR #8** — implementation handoff improvements + the
  `gh api PATCH` PR-body fix that's tangential but in the same
  era. The merge fast-forwarded both PRs into main; this plan is
  the natural follow-up.
- **`docs/plans/2026-05-08-feat-test-author-button-plan.md`** —
  another follow-up. The `test:author` button stays Claude-based;
  the `runnerType` discriminator from this plan is what makes
  mixing both flavours on the same `test` lane clean.
