import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { readUserPrefs } from "@/server/lib/userPrefs";
import {
  UsersTokenStatus,
  type UserTokenRow,
} from "@/components/admin/UsersTokenStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await auth();
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id) return null;
  if (user.role !== "admin") {
    return (
      <main className="flex h-screen items-center justify-center">
        <div className="rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700">
          Admin only. Your role:{" "}
          <span className="font-mono">{user.role ?? "member"}</span>
        </div>
      </main>
    );
  }

  // Per-user has-token chips. We never decrypt or read the actual
  // token values for this view — readUserPrefs returns them, but we
  // only inspect presence (truthy) for each subfield.
  const allUsers = db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(users)
    .all();

  const rows: UserTokenRow[] = allUsers.map((u) => {
    const prefs = readUserPrefs(u.id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      hasJira: !!prefs.credentials.jira,
      hasGithub: !!prefs.credentials.github,
      hasGit: !!prefs.credentials.git,
    };
  });

  // Aggregate stats for the header.
  const total = rows.length;
  const withAny = rows.filter(
    (r) => r.hasJira || r.hasGithub || r.hasGit,
  ).length;
  const withJira = rows.filter((r) => r.hasJira).length;
  const withGithub = rows.filter((r) => r.hasGithub).length;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            admin · users
          </div>
          <h1 className="mt-1 text-xl font-semibold">User credentials status</h1>
          <p className="mt-2 text-sm text-[color:var(--muted)]">
            Who has configured their own Jira / GitHub / Git identity. Token
            values are never displayed; this view only shows presence.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 text-xs">
          <Stat label="Total users" value={String(total)} />
          <Stat
            label="With any override"
            value={`${withAny} / ${total}`}
            tone="info"
          />
          <Stat label="Jira" value={`${withJira} / ${total}`} />
          <Stat label="GitHub" value={`${withGithub} / ${total}`} />
        </div>
      </header>

      <UsersTokenStatus rows={rows} currentAdminId={user.id} />

      <p className="mt-4 px-1 text-[11px] text-[color:var(--muted)]">
        Cleared tokens fall back to the instance default configured in{" "}
        <span className="font-mono">/admin/settings</span>. Audited as{" "}
        <span className="font-mono">credentials.cleared</span> with the
        admin&apos;s id in <span className="font-mono">clearedBy</span>.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "info" | "ok" | "warn";
}) {
  const toneClass =
    tone === "warn"
      ? "text-amber-600"
      : tone === "info"
        ? "text-[color:var(--accent)]"
        : "text-[color:var(--foreground)]";
  return (
    <div className="text-right">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
