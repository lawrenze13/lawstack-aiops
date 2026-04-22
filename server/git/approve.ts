import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { artifacts, prRecords, tasks, worktrees } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { audit } from "@/server/auth/audit";
import { postComment } from "@/server/jira/client";
import { robustPush } from "@/server/git/push";
import { prCommentDoc } from "@/server/jira/adf";
import { AppError, BadRequest, Conflict, NotFound } from "@/server/lib/errors";

const exec = promisify(execFile);

// Kinds we always include in the PR. Review is optional; plan + brainstorm
// are mandatory. Match what agent prompts produce.
const REQUIRED_KINDS = ["brainstorm", "plan"] as const;
const OPTIONAL_KINDS = ["review"] as const;

type ApproveStep = "drafting" | "committed" | "pushed" | "pr_opened" | "jira_notified";

type StepRecord = {
  state: ApproveStep;
  commitSha?: string;
  prUrl?: string;
  jiraCommentId?: string;
};

type ApproveResult =
  | {
      ok: true;
      prUrl: string;
      commitSha: string;
      jiraCommentId: string | null;
      jiraWarning: string | null;
    }
  | {
      ok: false;
      failedAt: ApproveStep;
      error: string;
    };

/**
 * Approve the current artifacts on a task: commit → push → gh pr create →
 * Jira comment. Idempotent per step — safe to re-invoke after a failure
 * to resume from the failed step.
 */
export async function approveAndPr(
  taskId: string,
  actorUserId: string,
): Promise<ApproveResult> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFound("task not found");
  if (task.status === "archived") throw new Conflict("task is archived");

  const wt = db.select().from(worktrees).where(eq(worktrees.taskId, taskId)).limit(1).get();
  if (!wt || wt.status !== "live") {
    throw new BadRequest("no live worktree for this task");
  }
  if (!env.BASE_REPO) throw new AppError("BASE_REPO is not configured");

  // Gather the latest artifact per kind for this task. Reject if required
  // kinds are missing or stale.
  const latestArtifacts = latestArtifactPerKind(taskId);
  for (const kind of REQUIRED_KINDS) {
    const a = latestArtifacts.get(kind);
    if (!a) throw new BadRequest(`missing required ${kind} artifact`);
    if (a.isStale) throw new BadRequest(`${kind} artifact is stale; re-run ${kind} before approving`);
  }

  // Acquire or create the pr_records row. If we're resuming, read state.
  const existing = db
    .select()
    .from(prRecords)
    .where(eq(prRecords.taskId, taskId))
    .limit(1)
    .get();

  const now = new Date();
  const branch = wt.branch;

  const record: StepRecord = existing
    ? {
        state: stripFailedPrefix(existing.state),
        commitSha: existing.commitSha ?? undefined,
        prUrl: existing.prUrl ?? undefined,
        jiraCommentId: existing.jiraCommentId ?? undefined,
      }
    : { state: "drafting" };

  if (!existing) {
    db.insert(prRecords)
      .values({ taskId, branch, state: "drafting", updatedAt: now })
      .run();
  }

  // ─── Step 1: write the latest artifact markdown into the worktree ────
  try {
    if (stepIsPending(record.state, "drafting")) {
      for (const kind of [...REQUIRED_KINDS, ...OPTIONAL_KINDS]) {
        const a = latestArtifacts.get(kind);
        if (!a) continue;
        const dir = kindDir(kind);
        const fullPath = path.join(wt.path, dir, a.filename);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, a.markdown, "utf8");
      }
    }
  } catch (err) {
    return failAt(taskId, "drafting", err);
  }

  // ─── Step 2: git add + commit ────────────────────────────────────────
  let commitSha = record.commitSha;
  try {
    if (stepIsPending(record.state, "committed")) {
      // Add expected directories; no-op if nothing to add.
      await exec(
        "git",
        ["add", "docs/brainstorms", "docs/plans", "docs/reviews"],
        { cwd: wt.path },
      ).catch(() => {
        // Some paths may not exist yet; `git add` of a missing dir fails.
        // Add individual files via the artifact list to be safe.
      });
      for (const kind of [...REQUIRED_KINDS, ...OPTIONAL_KINDS]) {
        const a = latestArtifacts.get(kind);
        if (!a) continue;
        await exec("git", ["add", path.join(kindDir(kind), a.filename)], {
          cwd: wt.path,
        }).catch(() => {});
      }

      // Is there anything to commit?
      const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], {
        cwd: wt.path,
      });
      if (!statusOut.trim()) {
        // Nothing new — reuse HEAD's commit sha.
        const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: wt.path });
        commitSha = stdout.trim();
      } else {
        const msg = `docs(${task.jiraKey}): AI brainstorm + plan\n\n${task.title}`;
        await exec(
          "git",
          [
            "-c",
            "user.email=ai-ops@multiportal.io",
            "-c",
            "user.name=lawstack-aiops",
            "commit",
            "-m",
            msg,
          ],
          { cwd: wt.path },
        );
        const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: wt.path });
        commitSha = stdout.trim();
      }

      db.update(prRecords)
        .set({ state: "committed", commitSha, updatedAt: new Date() })
        .where(eq(prRecords.taskId, taskId))
        .run();
      record.state = "committed";
      record.commitSha = commitSha;
    }
  } catch (err) {
    return failAt(taskId, "committed", err);
  }

  // ─── Step 3: git push ────────────────────────────────────────────────
  try {
    if (stepIsPending(record.state, "pushed")) {
      // robustPush handles non-fast-forward (rebase onto origin then retry)
      // and missing upstream (-u). Plain `git push` rejected the earlier
      // cases with "non-fast-forward" because a prior Approve run had
      // already advanced the remote; rebasing incorporates those commits.
      await robustPush(wt.path, branch);
      db.update(prRecords)
        .set({ state: "pushed", updatedAt: new Date() })
        .where(eq(prRecords.taskId, taskId))
        .run();
      record.state = "pushed";
    }
  } catch (err) {
    return failAt(taskId, "pushed", err);
  }

  // ─── Step 4: gh pr create (idempotent) ───────────────────────────────
  let prUrl = record.prUrl;
  try {
    if (stepIsPending(record.state, "pr_opened")) {
      // Check for an existing open PR first.
      const { stdout: existingJson } = await exec(
        "gh",
        ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number"],
        { cwd: wt.path, env: ghEnv() },
      );
      const existingPrs = JSON.parse(existingJson || "[]") as Array<{
        url: string;
        number: number;
      }>;
      if (existingPrs.length > 0) {
        prUrl = existingPrs[0]!.url;
      } else {
        const title = `[${task.jiraKey}] ${task.title}`;
        const body = buildPrBody(task.jiraKey, task.title, latestArtifacts);
        const { stdout } = await exec(
          "gh",
          [
            "pr",
            "create",
            "--draft",
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            title,
            "--body",
            body,
          ],
          { cwd: wt.path, env: ghEnv() },
        );
        prUrl = stdout.trim().split("\n").pop() ?? "";
      }
      db.update(prRecords)
        .set({
          state: "pr_opened",
          prUrl,
          openedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(prRecords.taskId, taskId))
        .run();
      record.state = "pr_opened";
      record.prUrl = prUrl;
    }
  } catch (err) {
    return failAt(taskId, "pr_opened", err);
  }

  // ─── Step 5: post Jira comment (non-fatal on failure) ────────────────
  let jiraCommentId: string | null = record.jiraCommentId ?? null;
  let jiraWarning: string | null = null;
  if (stepIsPending(record.state, "jira_notified")) {
    if (!prUrl) {
      jiraWarning = "no PR url captured; skipping Jira comment";
    } else {
      try {
        const artifactsForComment: Array<{
          kind: "brainstorm" | "plan" | "review";
          filename: string;
          markdown: string;
        }> = [];
        for (const kind of ["brainstorm", "plan", "review"] as const) {
          const a = latestArtifacts.get(kind);
          if (a) {
            artifactsForComment.push({
              kind,
              filename: a.filename,
              markdown: a.markdown,
            });
          }
        }
        const body = prCommentDoc({
          prUrl,
          jiraKey: task.jiraKey,
          title: task.title,
          artifacts: artifactsForComment,
        });
        jiraCommentId = await postComment(task.jiraKey, body);
        db.update(prRecords)
          .set({ state: "jira_notified", jiraCommentId, updatedAt: new Date() })
          .where(eq(prRecords.taskId, taskId))
          .run();
        record.state = "jira_notified";
      } catch (err) {
        // Jira-comment failure is non-fatal. Record the warning; user can
        // post manually. State stays at 'pr_opened' so Retry re-tries only
        // the Jira step.
        jiraWarning = `Jira comment failed: ${(err as Error).message}`;
        audit({
          action: "approve.jira_warn",
          actorUserId,
          taskId,
          payload: { prUrl, error: jiraWarning },
        });
      }
    }
  }

  // Mark the task as done on the board.
  db.update(tasks)
    .set({ currentLane: "pr", updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();

  audit({
    action: "approve.completed",
    actorUserId,
    taskId,
    payload: { prUrl, commitSha, jiraCommentId, jiraWarning },
  });

  return {
    ok: true,
    prUrl: prUrl ?? "",
    commitSha: commitSha ?? "",
    jiraCommentId,
    jiraWarning,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function latestArtifactPerKind(taskId: string): Map<
  "brainstorm" | "plan" | "review",
  { id: string; kind: "brainstorm" | "plan" | "review"; filename: string; markdown: string; isStale: boolean }
> {
  const out = new Map<
    "brainstorm" | "plan" | "review",
    { id: string; kind: "brainstorm" | "plan" | "review"; filename: string; markdown: string; isStale: boolean }
  >();
  for (const kind of ["brainstorm", "plan", "review"] as const) {
    const latest = db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        filename: artifacts.filename,
        markdown: artifacts.markdown,
        isStale: artifacts.isStale,
      })
      .from(artifacts)
      .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind)))
      .orderBy(desc(artifacts.createdAt))
      .limit(1)
      .all();
    if (latest[0])
      out.set(kind, {
        id: latest[0].id,
        // Approve's gate only uses the three planning kinds, so narrow
        // here. The schema enum also includes 'implementation' (Phase 5B)
        // which is never fetched in this loop.
        kind: latest[0].kind as "brainstorm" | "plan" | "review",
        filename: latest[0].filename,
        markdown: latest[0].markdown,
        isStale: latest[0].isStale,
      });
  }
  return out;
}

function kindDir(kind: "brainstorm" | "plan" | "review"): string {
  switch (kind) {
    case "brainstorm":
      return "docs/brainstorms";
    case "plan":
      return "docs/plans";
    case "review":
      return "docs/reviews";
  }
}

function buildPrBody(
  jiraKey: string,
  title: string,
  latestArtifacts: ReturnType<typeof latestArtifactPerKind>,
): string {
  const lines: string[] = [];
  lines.push(`Auto-generated docs for **${jiraKey}**: ${title}`);
  lines.push("");
  for (const kind of ["brainstorm", "plan", "review"] as const) {
    const a = latestArtifacts.get(kind);
    if (a) lines.push(`- ${kind}: \`${kindDir(kind)}/${a.filename}\``);
  }
  lines.push("");
  lines.push("Review, refine, then undraft when ready to implement.");
  lines.push("");
  lines.push("_Generated by LawStack/aiops._");
  return lines.join("\n");
}

function ghEnv(): NodeJS.ProcessEnv {
  const baseline: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
  };
  if (process.env.GH_TOKEN) baseline.GH_TOKEN = process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) baseline.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  return baseline;
}

function stepIsPending(current: ApproveStep, target: ApproveStep): boolean {
  const order: ApproveStep[] = ["drafting", "committed", "pushed", "pr_opened", "jira_notified"];
  return order.indexOf(current) < order.indexOf(target);
}

function stripFailedPrefix(raw: string): ApproveStep {
  // Handle both 'failed_at_pushed' (legacy) and 'failed_at_push' / 'failed_at_pr' / etc.
  const map: Record<string, ApproveStep> = {
    drafting: "drafting",
    committed: "committed",
    pushed: "pushed",
    pr_opened: "pr_opened",
    jira_notified: "jira_notified",
    failed_at_drafting: "drafting",
    failed_at_commit: "drafting",
    failed_at_push: "committed",
    failed_at_pr: "pushed",
    failed_at_jira: "pr_opened",
  };
  return (map[raw] as ApproveStep) ?? "drafting";
}

function failAt(
  taskId: string,
  step: ApproveStep,
  err: unknown,
): ApproveResult {
  const stateMap: Record<ApproveStep, string> = {
    drafting: "failed_at_drafting",
    committed: "failed_at_commit",
    pushed: "failed_at_push",
    pr_opened: "failed_at_pr",
    jira_notified: "failed_at_jira",
  };
  const error = (err as Error).message ?? String(err);
  db.update(prRecords)
    .set({ state: stateMap[step] as never, updatedAt: new Date() })
    .where(eq(prRecords.taskId, taskId))
    .run();
  audit({
    action: "approve.step_failed",
    taskId,
    payload: { step, error },
  });
  return { ok: false, failedAt: step, error };
}
