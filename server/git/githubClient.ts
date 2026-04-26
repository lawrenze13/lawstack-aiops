import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "@/server/lib/redactSecrets";
import { resolveCredentials } from "@/server/integrations/credentials";
import { CredentialsInvalidError } from "@/server/jira/client";

const exec = promisify(execFile);

// Wrapper around the GitHub CLI (`gh`). Single creds binding per
// logical operation — methods on a single instance never mix tokens.
//
// The `gh` CLI authenticates via `GH_TOKEN` / `GITHUB_TOKEN` env vars
// (preferred over `gh auth login`-stored credentials when both exist).
// We pass the per-run token here; the parent process's env is NOT
// inherited beyond a small allowlist (NODE_ENV, PATH, HOME).

export type GithubCreds = {
  token: string;
};

export interface PrCreateOpts {
  cwd: string;
  title: string;
  body: string;
  base: string;
  head: string;
  draft?: boolean;
}

export interface PrInfo {
  url: string;
  number: number;
}

export class GithubClient {
  constructor(private readonly creds: GithubCreds) {
    if (!creds.token) {
      throw new GithubNotConfiguredError();
    }
  }

  /**
   * Returns the env object to pass to `child_process.exec("gh", ...)`.
   * Explicit allowlist — never spreads `process.env`. The `gh` binary
   * needs `PATH` (to find git) and `HOME` (for its config), nothing
   * else. `GH_TOKEN` and `GITHUB_TOKEN` are both set so `gh` picks up
   * whichever it checks first.
   */
  ghEnv(): NodeJS.ProcessEnv {
    return Object.freeze({
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GH_TOKEN: this.creds.token,
      GITHUB_TOKEN: this.creds.token,
    }) as NodeJS.ProcessEnv;
  }

  async prList(branch: string, cwd: string): Promise<PrInfo[]> {
    try {
      const { stdout } = await exec(
        "gh",
        ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number"],
        { cwd, env: this.ghEnv() },
      );
      return JSON.parse(stdout || "[]") as PrInfo[];
    } catch (err) {
      throwOnAuthFailure(err);
      throw new Error(`gh pr list failed: ${redactSecrets((err as Error).message)}`);
    }
  }

  async prCreate(opts: PrCreateOpts): Promise<string> {
    try {
      const args = [
        "pr",
        "create",
        ...(opts.draft ? ["--draft"] : []),
        "--base",
        opts.base,
        "--head",
        opts.head,
        "--title",
        opts.title,
        "--body",
        opts.body,
      ];
      const { stdout } = await exec("gh", args, { cwd: opts.cwd, env: this.ghEnv() });
      return stdout.trim().split("\n").pop() ?? "";
    } catch (err) {
      throwOnAuthFailure(err);
      throw new Error(`gh pr create failed: ${redactSecrets((err as Error).message)}`);
    }
  }

  async prReady(branch: string, cwd: string): Promise<void> {
    try {
      await exec("gh", ["pr", "ready", branch], { cwd, env: this.ghEnv() });
    } catch (err) {
      throwOnAuthFailure(err);
      throw new Error(`gh pr ready failed: ${redactSecrets((err as Error).message)}`);
    }
  }
}

export class GithubNotConfiguredError extends Error {
  constructor() {
    super("GitHub credentials are not configured (GITHUB_TOKEN).");
  }
}

/**
 * `gh` exits non-zero with stderr containing "401" / "Bad credentials"
 * on auth failure. Map to our typed error so the worker can mark the
 * run failed with `credentials_invalid:github` reason.
 */
function throwOnAuthFailure(err: unknown): void {
  const msg = (err as Error).message ?? "";
  if (
    /\b401\b|Bad credentials|HTTP 403|requires authentication/i.test(msg)
  ) {
    throw new CredentialsInvalidError("github", 401, msg);
  }
}

/**
 * Construct a GithubClient from instance-default creds. Returns null
 * if not configured. Used by legacy callers that haven't been
 * refactored to accept a RunContext yet.
 */
export function makeInstanceGithubClient(): GithubClient | null {
  const resolved = resolveCredentials(null, "github");
  if (resolved.source === "missing") return null;
  return new GithubClient({ token: String(resolved.value.token) });
}
