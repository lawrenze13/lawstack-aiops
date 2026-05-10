#!/usr/bin/env tsx
/**
 * Test-lane runner: replaces the Claude-based `test:playwright` agent
 * with a deterministic shell orchestration script. Forked by
 * `server/worker/spawnAgent.ts:spawnScriptInner` with
 *   cwd = <worktree>
 *   args = [jiraKey, branch?]
 *   env = minimised allow-list + AIOPS_TASK_ID + AIOPS_RUN_ID
 *         + (optional) PLAYWRIGHT_TIMEOUT_MS
 *
 * Contract:
 *   1. Detect Playwright (`playwright.config.{ts,js,mjs}` in cwd).
 *      Missing → write a SKIPPED artifact, exit 0.
 *   2. Run `pnpm playwright install --with-deps` (idempotent).
 *   3. Run `pnpm playwright test --reporter=list --reporter=json:test-results.json`.
 *   4. Parse `test-results.json`. Compute pass/fail + failing-spec list.
 *      Missing/malformed JSON → fall back to FAIL with a note.
 *   5. Write `docs/tests/<jiraKey>-test.md` with the YAML frontmatter
 *      `parseTestArtifact` (server/git/testComplete.ts) reads:
 *        ---
 *        ticket, date, status, verdict (PASS|FAIL|SKIPPED),
 *        passed, failed
 *        ---
 *      Followed by a "Failing specs" section on FAIL.
 *   6. Exit 0 on PASS or SKIPPED, 1 on FAIL.
 *
 * Lifecycle:
 *   - SIGTERM is propagated to the Playwright child so killing this
 *     script doesn't orphan browsers / port 3000.
 *   - Hard timeout (PLAYWRIGHT_TIMEOUT_MS, default 30 min) caps the
 *     suite. On timeout, write a FAIL artifact with a clear note and
 *     exit 1 — prevents an infinite-loop test from holding the
 *     orchestrator's mutex forever.
 *
 * The script is self-contained — no imports from aiops's server code.
 * Easier to run standalone for debugging, simpler error surface.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [jiraKey, branchArg] = process.argv.slice(2);
const branch = branchArg ?? "(unknown)";
if (!jiraKey) {
  console.error("usage: run-playwright.ts <jiraKey> [branch]");
  process.exit(2);
}

const cwd = process.cwd();
const docsTestsDir = path.join(cwd, "docs/tests");
mkdirSync(docsTestsDir, { recursive: true });

const artifactPath = path.join(docsTestsDir, `${jiraKey}-test.md`);
const today = new Date().toISOString().slice(0, 10);
const startedAt = new Date().toISOString();

// ─── 1. Detect Playwright ─────────────────────────────────────────────
const configFile = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]
  .map((f) => path.join(cwd, f))
  .find(existsSync);

if (!configFile) {
  writeArtifact("SKIPPED", 0, 0, [], {
    note: "Playwright is not configured in this managed repo (no playwright.config.{ts,js,mjs}). Add the config + install @playwright/test to enable the test lane.",
  });
  process.exit(0);
}

// ─── 2. SIGTERM propagation ───────────────────────────────────────────
let pwChild: ChildProcess | undefined;
let signalled = false;
const propagateSignal = (sig: NodeJS.Signals) => {
  signalled = true;
  if (pwChild && !pwChild.killed) {
    try {
      pwChild.kill(sig);
    } catch {
      // ignore
    }
  }
  // Force-exit after a 1s grace if the child doesn't die.
  setTimeout(() => process.exit(143), 1000).unref();
};
process.on("SIGTERM", () => propagateSignal("SIGTERM"));
process.on("SIGINT", () => propagateSignal("SIGINT"));

// ─── 3. Hard timeout ──────────────────────────────────────────────────
const timeoutMs = parseIntSafe(process.env.PLAYWRIGHT_TIMEOUT_MS, 30 * 60 * 1000);
const timeoutHandle = setTimeout(() => {
  if (pwChild && !pwChild.killed) pwChild.kill("SIGTERM");
  writeArtifact("FAIL", 0, 1, [`Suite exceeded ${timeoutMs}ms timeout`], {
    note: `Hard timeout after ${Math.round(timeoutMs / 1000)}s. Tighten test scope or raise PLAYWRIGHT_TIMEOUT_MS.`,
  });
  process.exit(1);
}, timeoutMs);
timeoutHandle.unref();

// ─── 4. Install browsers + run tests ──────────────────────────────────
async function main(): Promise<void> {
  // Install is idempotent — browsers cache to ~/.cache/ms-playwright,
  // which is in HOME and persists across runs.
  const installCode = await runStep("pnpm", ["playwright", "install", "--with-deps"]);
  if (installCode !== 0 && !signalled) {
    writeArtifact("FAIL", 0, 1, [`pnpm playwright install exited ${installCode}`], {
      note: "Browser install failed. Operator: check the run log for the underlying error (likely missing system deps or a network issue).",
    });
    clearTimeout(timeoutHandle);
    process.exit(1);
  }

  const testCode = await runStep("pnpm", [
    "playwright",
    "test",
    "--reporter=list",
    `--reporter=json:${path.join(cwd, "test-results.json")}`,
  ]);

  clearTimeout(timeoutHandle);
  if (signalled) {
    // Stop button or SIGTERM. propagateSignal already exits.
    return;
  }

  // ─── 5. Parse results ─────────────────────────────────────────────
  const jsonPath = path.join(cwd, "test-results.json");
  const parsed = parseResults(jsonPath, testCode);

  const verdict: "PASS" | "FAIL" =
    parsed.failed === 0 && testCode === 0 ? "PASS" : "FAIL";

  writeArtifact(verdict, parsed.passed, parsed.failed, parsed.failingSpecs);
  process.exit(verdict === "PASS" ? 0 : 1);
}

void main();

// ─── Helpers ──────────────────────────────────────────────────────────

function parseIntSafe(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function runStep(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    pwChild = child;
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(`[run-playwright] failed to spawn ${cmd}:`, err);
      resolve(1);
    });
  });
}

type ParsedResults = {
  passed: number;
  failed: number;
  failingSpecs: string[];
};

function parseResults(jsonPath: string, fallbackExitCode: number): ParsedResults {
  if (!existsSync(jsonPath)) {
    return {
      passed: 0,
      failed: fallbackExitCode === 0 ? 0 : 1,
      failingSpecs:
        fallbackExitCode === 0
          ? []
          : ["test-results.json missing — see run log for raw Playwright output"],
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    return {
      passed: 0,
      failed: 1,
      failingSpecs: [
        `test-results.json malformed (${(err as Error).message}) — see run log for raw output`,
      ],
    };
  }
  const stats = (json as { stats?: Record<string, number> }).stats ?? {};
  const passed = stats.expected ?? 0;
  const failed = (stats.unexpected ?? 0) + (stats.flaky ?? 0);
  const failingSpecs: string[] = [];
  if (failed > 0) {
    walkSuites(
      ((json as { suites?: unknown[] }).suites ?? []) as PlaywrightSuite[],
      failingSpecs,
    );
  }
  return { passed, failed, failingSpecs };
}

// Trimmed Playwright JSON-reporter shapes — only the fields we read.
type PlaywrightTestResult = { status?: string };
type PlaywrightTest = {
  results?: PlaywrightTestResult[];
};
type PlaywrightSpec = {
  title?: string;
  file?: string;
  tests?: PlaywrightTest[];
};
type PlaywrightSuite = {
  title?: string;
  file?: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
};

function walkSuites(suites: PlaywrightSuite[], out: string[]): void {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      const failed = (spec.tests ?? []).some((t) =>
        (t.results ?? []).some((r) => r.status === "failed" || r.status === "timedOut"),
      );
      if (failed) {
        const file = spec.file ?? suite.file ?? "(unknown file)";
        const title = spec.title ?? "(unnamed test)";
        out.push(`${file} › ${title}`);
      }
    }
    if (suite.suites) walkSuites(suite.suites, out);
  }
}

function writeArtifact(
  verdict: "PASS" | "FAIL" | "SKIPPED",
  passed: number,
  failed: number,
  failing: string[],
  opts: { note?: string } = {},
): void {
  const total = passed + failed;
  const summary =
    verdict === "PASS"
      ? `Playwright passed (${passed}/${total})`
      : verdict === "FAIL"
        ? `Playwright failed (${failed}/${total} specs failing)`
        : "Playwright skipped — not configured";

  const lines: string[] = [
    "---",
    `ticket: ${jiraKey}`,
    `date: ${today}`,
    "status: draft",
    `verdict: ${verdict}`,
    `passed: ${passed}`,
    `failed: ${failed}`,
    "---",
    "",
    `# ${summary}`,
    "",
  ];

  if (opts.note) {
    lines.push(opts.note, "");
  }

  if (failing.length > 0) {
    lines.push("## Failing specs", "");
    for (const f of failing) lines.push(`- ${f}`);
    lines.push("");
  }

  lines.push(
    "## Run metadata",
    "",
    `- Branch: \`${branch}\``,
    `- Started: ${startedAt}`,
    `- Reports: \`playwright-report/index.html\` (server copies to TEST_REPORTS_ROOT post-run)`,
    "",
  );

  writeFileSync(artifactPath, lines.join("\n"), "utf8");
}
