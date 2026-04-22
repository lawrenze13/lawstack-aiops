import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { TestActionId } from "./settingsSchema";

const exec = promisify(execFile);
const TIMEOUT_MS = 10_000;

export type TestResult = {
  ok: boolean;
  message: string;
  /** Optional per-action structured details (e.g., gh + claude split). */
  details?: Record<string, { ok: boolean; message: string }>;
};

type TestHandler = (payload: Record<string, unknown>) => Promise<TestResult>;

// ─── Individual handlers ────────────────────────────────────────────────────

const testJira: TestHandler = async (payload) => {
  const baseUrl = String(payload.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const email = String(payload.JIRA_EMAIL ?? "");
  const apiToken = String(payload.JIRA_API_TOKEN ?? "");
  if (!baseUrl || !email || !apiToken) {
    return { ok: false, message: "fill base URL, email, and API token first" };
  }
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
        Accept: "application/json",
      },
    });
    clearTimeout(to);
    if (!res.ok) {
      return {
        ok: false,
        message: `Jira returned HTTP ${res.status}. Verify base URL and that the API token belongs to this email.`,
      };
    }
    const me = (await res.json()) as { displayName?: string };
    return {
      ok: true,
      message: `Signed in as ${me.displayName ?? "(name missing)"}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Jira request failed: ${(err as Error).message}`,
    };
  }
};

const testPath: TestHandler = async (payload) => {
  const path = String(payload.path ?? payload.BASE_REPO ?? "");
  const mustBeGit = payload.mustBeGit !== false;
  if (!path) return { ok: false, message: "path is empty" };
  if (!existsSync(path)) {
    return { ok: false, message: `path does not exist: ${path}` };
  }
  if (!mustBeGit) {
    return { ok: true, message: `path exists: ${path}` };
  }
  try {
    const { stdout } = await exec(
      "git",
      ["-C", path, "rev-parse", "--is-inside-work-tree"],
      { timeout: TIMEOUT_MS },
    );
    if (stdout.trim() !== "true") {
      return { ok: false, message: "path is not inside a git work tree" };
    }
    return { ok: true, message: "valid git repository" };
  } catch (err) {
    return {
      ok: false,
      message: `not a git repo: ${(err as Error).message}`,
    };
  }
};

const testOauthShape: TestHandler = async (payload) => {
  const id = String(payload.AUTH_GOOGLE_ID ?? "");
  const secret = String(payload.AUTH_GOOGLE_SECRET ?? "");
  const problems: string[] = [];
  if (!id.endsWith(".apps.googleusercontent.com")) {
    problems.push("client ID should end with .apps.googleusercontent.com");
  }
  if (secret.length < 24) {
    problems.push("client secret looks too short (≥24 chars expected)");
  }
  if (problems.length > 0) {
    return { ok: false, message: problems.join("; ") };
  }
  return {
    ok: true,
    message:
      "Shape looks right. Actual OAuth exchange happens after you sign in.",
  };
};

const testCli: TestHandler = async () => {
  const results: Record<string, { ok: boolean; message: string }> = {};
  try {
    await exec("gh", ["auth", "status"], { timeout: TIMEOUT_MS });
    results.gh = { ok: true, message: "gh is authenticated" };
  } catch (err) {
    results.gh = {
      ok: false,
      message:
        "`gh auth status` failed. Run `gh auth login` in a terminal on this host.",
    };
  }
  try {
    const { stdout } = await exec("claude", ["--version"], {
      timeout: TIMEOUT_MS,
    });
    results.claude = { ok: true, message: stdout.trim() };
  } catch (err) {
    results.claude = {
      ok: false,
      message:
        "`claude --version` failed. Install Claude CLI and run `claude login`.",
    };
  }
  const ok = results.gh!.ok && results.claude!.ok;
  return {
    ok,
    message: ok ? "gh + claude CLI ready" : "CLI prerequisites missing",
    details: results,
  };
};

const testGithubApi: TestHandler = async (payload) => {
  const repo = String(payload.repo ?? "");
  if (!repo || !repo.includes("/")) {
    return { ok: false, message: "repo must be `owner/name`" };
  }
  try {
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${repo}`, "--jq", ".full_name"],
      { timeout: TIMEOUT_MS },
    );
    return { ok: true, message: `accessible: ${stdout.trim()}` };
  } catch (err) {
    return {
      ok: false,
      message: `gh api failed: ${(err as Error).message.slice(0, 200)}`,
    };
  }
};

const testGithubWorkflow: TestHandler = async (payload) => {
  const repo = String(payload.repo ?? "");
  const workflow = String(payload.workflow ?? "claude-code-review.yml");
  if (!repo) return { ok: false, message: "repo is required" };
  try {
    await exec(
      "gh",
      ["workflow", "view", workflow, "-R", repo],
      { timeout: TIMEOUT_MS },
    );
    return { ok: true, message: `${workflow} is present in ${repo}` };
  } catch (err) {
    return {
      ok: false,
      message: `workflow ${workflow} not found in ${repo}: paste it into .github/workflows/ and push first.`,
    };
  }
};

// ─── Dispatcher ─────────────────────────────────────────────────────────────

const HANDLERS: Record<TestActionId, TestHandler> = {
  jira: testJira,
  path: testPath,
  "oauth-shape": testOauthShape,
  cli: testCli,
  "github-api": testGithubApi,
  "github-workflow": testGithubWorkflow,
};

export async function runTestAction(
  id: string,
  payload: Record<string, unknown>,
): Promise<TestResult> {
  const handler = HANDLERS[id as TestActionId];
  if (!handler) {
    return { ok: false, message: `unknown test action: ${id}` };
  }
  return handler(payload);
}
