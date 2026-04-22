import { exec as execCb, type ExecException } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAuth } from "@/server/lib/route";
import {
  AppError,
  BadRequest,
  Forbidden,
  NotFound,
} from "@/server/lib/errors";
import { db } from "@/server/db/client";
import { tasks } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { audit } from "@/server/auth/audit";

export const runtime = "nodejs";

// 30s hard cap — long enough for composer install, short enough that a
// runaway command doesn't wedge the node worker.
const TIMEOUT_MS = 30_000;
// 256 KB of combined stdout+stderr. Larger outputs get truncated.
const MAX_BUFFER = 256 * 1024;

const Body = z.object({
  command: z.string().trim().min(1).max(2000),
});

/**
 * POST /api/tasks/:id/preview-shell
 *
 * Run an arbitrary shell command in `PREVIEW_DEV_PATH` and return stdout
 * + stderr + exit code. THIS IS EFFECTIVELY REMOTE CODE EXECUTION as
 * the Node.js process user — gated by:
 *   1. `PREVIEW_DEV_ENABLE_SHELL=true` env flag (off by default)
 *   2. Owner / admin auth on the task
 *   3. Audit-logged, every command
 *
 * Fine for a single-operator dev box. Do NOT enable on a shared prod
 * orchestrator.
 */
export const POST = withAuth(async ({ req, user }) => {
  if (!env.PREVIEW_DEV_ENABLE_SHELL) {
    throw new Forbidden("dev shell disabled; set PREVIEW_DEV_ENABLE_SHELL=true");
  }
  if (!env.PREVIEW_DEV_PATH) {
    throw new AppError("PREVIEW_DEV_PATH is not set");
  }
  if (!existsSync(env.PREVIEW_DEV_PATH)) {
    throw new AppError(`PREVIEW_DEV_PATH does not exist: ${env.PREVIEW_DEV_PATH}`);
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const taskId = segments[segments.length - 2];
  if (!taskId) throw new BadRequest("missing task id");

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (user.role !== "admin" && task.ownerId !== user.id) {
    throw new Forbidden("only the card owner or an admin can run dev commands");
  }

  const body = Body.parse(await req.json());

  const started = Date.now();
  const result = await runShell(body.command, env.PREVIEW_DEV_PATH);
  const durationMs = Date.now() - started;

  audit({
    action: "preview.shell_run",
    actorUserId: user.id,
    taskId,
    payload: {
      command: body.command.slice(0, 500),
      exitCode: result.exitCode,
      durationMs,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      truncated: result.truncated,
    },
  });

  return {
    command: body.command,
    cwd: env.PREVIEW_DEV_PATH,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs,
    truncated: result.truncated,
  };
});

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    // Minimal env — don't leak orchestrator secrets (AUTH_SECRET,
    // CLAUDE_CODE_OAUTH_TOKEN, etc.) into the dev shell. Double-cast
    // through `unknown` to satisfy ProcessEnv's required NODE_ENV
    // field; node doesn't actually require it at runtime.
    const childEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? cwd,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TERM: "xterm-256color",
    } as unknown as NodeJS.ProcessEnv;
    execCb(
      command,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: childEnv },
      (err: ExecException | null, stdout: string, stderr: string) => {
        // Node types `err.code` as string (signal name) OR number
        // (exit code from killed-by-signal). Normalise to an int for
        // the UI; 0 when no error.
        const code = err?.code;
        const exitCode = typeof code === "number" ? code : err ? 1 : 0;
        const truncated =
          typeof code === "string" && code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
          truncated,
        });
      },
    );
  });
}
