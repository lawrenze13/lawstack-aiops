import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Link from "next/link";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  TableBody,
  TableCell,
  TableColumn,
  TableContent,
  TableHeader,
  TableRoot,
  TableRow,
  TableScrollContainer,
} from "@heroui/react/table";
import { Chip } from "@heroui/react/chip";
import {
  RUN_STATUS_CHIP,
  type RunStatusUI,
} from "@/components/ui/tokens";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { auditLog, runs, tasks, worktrees } from "@/server/db/schema";
import { env } from "@/server/lib/env";
import { KillRunButton } from "./KillRunButton";
import { AutoRefresh } from "./AutoRefresh";
import { SettingsDriftBanner } from "@/components/admin/SettingsDriftBanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

const STUCK_HEARTBEAT_MS = 90 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export default async function AdminOpsPage() {
  const session = await auth();
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id) return null;
  if (user.role !== "admin") {
    return (
      <main className="flex h-screen items-center justify-center">
        <div className="rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700">
          Admin only. Your role: <span className="font-mono">{user.role ?? "member"}</span>
        </div>
      </main>
    );
  }

  const now = Date.now();

  // Stuck runs: status=running, heartbeat too old OR started long ago with no heartbeat.
  const staleCutoff = new Date(now - STUCK_HEARTBEAT_MS);
  const stuckRuns = db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      lane: runs.lane,
      agentId: runs.agentId,
      claudeSessionId: runs.claudeSessionId,
      costUsdMicros: runs.costUsdMicros,
      numTurns: runs.numTurns,
      startedAt: runs.startedAt,
      lastHeartbeatAt: runs.lastHeartbeatAt,
      jiraKey: tasks.jiraKey,
      taskTitle: tasks.title,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(runs.status, "running"), lt(runs.lastHeartbeatAt, staleCutoff)))
    .orderBy(desc(runs.startedAt))
    .all();

  // Live run count (from DB — running status means either alive or stuck-but-recent).
  const liveCountRow = db
    .select({ count: sql<number>`count(*)` })
    .from(runs)
    .where(eq(runs.status, "running"))
    .get();
  const liveRunCount = Number(liveCountRow?.count ?? 0);

  // Failed runs in last 24h.
  const since24h = new Date(now - DAY_MS);
  const recentFailed = db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      lane: runs.lane,
      status: runs.status,
      killedReason: runs.killedReason,
      costUsdMicros: runs.costUsdMicros,
      finishedAt: runs.finishedAt,
      jiraKey: tasks.jiraKey,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        sql`${runs.status} IN ('failed','cost_killed','stopped','interrupted')`,
        gte(runs.finishedAt, since24h),
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .all();

  // Cost by day — last 30 days.
  const since30d = new Date(now - 30 * DAY_MS);
  const costByDay = db
    .select({
      day: sql<string>`date(${runs.startedAt} / 1000, 'unixepoch', 'localtime')`,
      totalMicros: sql<number>`sum(${runs.costUsdMicros})`,
      runCount: sql<number>`count(*)`,
    })
    .from(runs)
    .where(gte(runs.startedAt, since30d))
    .groupBy(sql`date(${runs.startedAt} / 1000, 'unixepoch', 'localtime')`)
    .orderBy(sql`date(${runs.startedAt} / 1000, 'unixepoch', 'localtime') desc`)
    .all();

  // Audit log — last 50.
  const recentAudit = db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      taskId: auditLog.taskId,
      runId: auditLog.runId,
      payloadJson: auditLog.payloadJson,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.ts))
    .limit(50)
    .all();

  // Worktree disk usage (best-effort; non-fatal if `du` fails or dir missing).
  const worktreeUsage = await getWorktreeUsage(env.WORKTREE_ROOT);

  const totalCost30d = costByDay.reduce(
    (acc, d) => acc + Number(d.totalMicros ?? 0),
    0,
  );

  return (
    <>
    <SettingsDriftBanner role={user.role} />
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-[color:var(--border)] bg-[color:var(--background)]/80 px-6 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <Link
              href="/"
              className="text-xs text-[color:var(--muted)] hover:underline"
            >
              ← Board
            </Link>
            <div className="mt-1 flex items-center gap-3">
              <h1 className="font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                admin · ops
              </h1>
              <AutoRefresh intervalMs={15_000} />
            </div>
          </div>
          <div className="flex items-center gap-6 text-xs">
            <Stat label="Live runs" value={String(liveRunCount)} />
            <Stat
              label="Stuck"
              value={String(stuckRuns.length)}
              tone={stuckRuns.length > 0 ? "warn" : "ok"}
            />
            <Stat
              label="Failed (24h)"
              value={String(recentFailed.length)}
              tone={recentFailed.length > 0 ? "warn" : "ok"}
            />
            <Stat
              label="Cost (30d)"
              value={`$${(totalCost30d / 1_000_000).toFixed(2)}`}
            />
            <Stat
              label="Worktree disk"
              value={worktreeUsage.total ?? "—"}
              title={worktreeUsage.error ?? undefined}
            />
          </div>
        </div>
      </header>

      <section className="grid grid-cols-12 gap-4 p-4">
        <Panel title={`Stuck runs (${stuckRuns.length})`} className="col-span-12">
          {stuckRuns.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[color:var(--muted)]">
              None. Runs with <code>status=running</code> &amp; no heartbeat in{" "}
              {STUCK_HEARTBEAT_MS / 1000}s appear here.
            </p>
          ) : (
            <Table
              headers={["run", "ticket", "lane", "agent", "started", "last hb", "cost", "turns", ""]}
              rows={stuckRuns.map((r) => [
                <Link
                  key="id"
                  href={`/cards/${r.taskId}`}
                  className="font-mono text-xs hover:underline"
                >
                  {r.id.slice(0, 8)}
                </Link>,
                <span key="k" className="font-mono text-xs">
                  {r.jiraKey}
                </span>,
                r.lane,
                r.agentId,
                fmtTime(r.startedAt),
                r.lastHeartbeatAt ? fmtAgo(r.lastHeartbeatAt, now) : "—",
                `$${(r.costUsdMicros / 1_000_000).toFixed(4)}`,
                String(r.numTurns),
                <KillRunButton key="kill" runId={r.id} />,
              ])}
            />
          )}
        </Panel>

        <Panel title={`Failed runs (last 24h · ${recentFailed.length})`} className="col-span-7">
          {recentFailed.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[color:var(--muted)]">
              None.
            </p>
          ) : (
            <Table
              headers={["run", "ticket", "lane", "status", "reason", "cost", "finished"]}
              rows={recentFailed.map((r) => [
                <Link
                  key="id"
                  href={`/cards/${r.taskId}`}
                  className="font-mono text-xs hover:underline"
                >
                  {r.id.slice(0, 8)}
                </Link>,
                <span key="k" className="font-mono text-xs">
                  {r.jiraKey}
                </span>,
                r.lane,
                <StatusBadge key="s" status={r.status} />,
                <span key="r" className="font-mono text-[10px]">
                  {r.killedReason ?? "—"}
                </span>,
                `$${(r.costUsdMicros / 1_000_000).toFixed(4)}`,
                r.finishedAt ? fmtAgo(r.finishedAt, now) : "—",
              ])}
            />
          )}
        </Panel>

        <Panel title="Cost by day (last 30d)" className="col-span-5">
          <Table
            headers={["day", "runs", "total"]}
            rows={costByDay.map((d) => [
              <span key="d" className="font-mono text-xs">
                {d.day}
              </span>,
              String(d.runCount ?? 0),
              `$${(Number(d.totalMicros ?? 0) / 1_000_000).toFixed(4)}`,
            ])}
          />
        </Panel>

        <Panel title="Audit log (latest 50)" className="col-span-12">
          <Table
            headers={["when", "action", "actor", "task", "run", "payload"]}
            rows={recentAudit.map((a) => [
              fmtAgo(a.ts, now),
              <span key="a" className="font-mono text-[11px]">
                {a.action}
              </span>,
              <span key="u" className="font-mono text-[10px] text-[color:var(--muted)]">
                {a.actorUserId ? a.actorUserId.slice(0, 8) : "—"}
              </span>,
              a.taskId ? (
                <Link
                  key="t"
                  href={`/cards/${a.taskId}`}
                  className="font-mono text-[10px] hover:underline"
                >
                  {a.taskId.slice(0, 8)}
                </Link>
              ) : (
                "—"
              ),
              a.runId ? (
                <span key="r" className="font-mono text-[10px] text-[color:var(--muted)]">
                  {a.runId.slice(0, 8)}
                </span>
              ) : (
                "—"
              ),
              <code
                key="p"
                className="block max-w-md truncate text-[10px] text-[color:var(--muted)]"
                title={a.payloadJson ?? ""}
              >
                {truncate(a.payloadJson ?? "", 120)}
              </code>,
            ])}
          />
        </Panel>
      </section>
    </main>
    </>
  );
}

// ─── Helper components ─────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  title?: string;
}) {
  const color =
    tone === "warn"
      ? "text-amber-700"
      : "text-[color:var(--foreground)]";
  return (
    <div className="flex flex-col items-end" title={title}>
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
        {label}
      </span>
      <span className={`font-mono text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function Panel({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-[color:var(--border)] ${className ?? ""}`}>
      <div className="border-b border-[color:var(--border)] px-3 py-1.5 text-xs font-semibold">
        {title}
      </div>
      <div className="max-h-[60vh] overflow-auto">{children}</div>
    </div>
  );
}

/**
 * Thin wrapper around HeroUI v3's compound Table so the 4 admin call sites
 * keep using the simple `headers + rows` prop shape. The Table is not
 * interactive (no sort, no select) — React-Aria's TableView gives us
 * a11y labels + keyboard nav for free anyway.
 */
function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<React.ReactNode>>;
}) {
  return (
    <TableRoot aria-label="admin ops data">
      <TableScrollContainer>
        <TableContent>
          <TableHeader>
            {headers.map((h, i) => (
              <TableColumn key={i} isRowHeader={i === 0}>
                {h}
              </TableColumn>
            ))}
          </TableHeader>
          <TableBody>
            {rows.map((row, ri) => (
              <TableRow key={ri}>
                {row.map((cell, ci) => (
                  <TableCell key={ci}>{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </TableContent>
      </TableScrollContainer>
    </TableRoot>
  );
}

function StatusBadge({ status }: { status: string }) {
  const props =
    (RUN_STATUS_CHIP as Record<string, (typeof RUN_STATUS_CHIP)[RunStatusUI]>)[
      status
    ] ?? RUN_STATUS_CHIP.completed;
  return (
    <Chip {...props} size="sm" className="uppercase text-[9px]">
      {status}
    </Chip>
  );
}

function fmtTime(d: Date | number | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toLocaleTimeString();
}

function fmtAgo(d: Date | number, nowMs: number): string {
  const ts = typeof d === "number" ? d : d.getTime();
  const diff = Math.max(0, nowMs - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function getWorktreeUsage(
  root: string,
): Promise<{ total: string | null; error: string | null }> {
  try {
    const { stdout } = await exec("du", ["-sh", root], { timeout: 5000 });
    const total = stdout.split(/\s+/)[0] ?? null;
    return { total, error: null };
  } catch (err) {
    return { total: null, error: (err as Error).message };
  }
}
