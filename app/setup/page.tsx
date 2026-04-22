import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /setup — entry point for the first-run wizard.
 *
 * Behaviour:
 *   - If users table has any rows → setup is complete; redirect to /sign-in.
 *   - Otherwise, forward to /setup/step/1 carrying the token through.
 *
 * Token validation itself happens on each step's API calls (save + test);
 * this landing page is informational.
 */
export default async function SetupEntry({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  const anyUser = db.select({ id: users.id }).from(users).limit(1).all();
  if (anyUser.length > 0) {
    redirect("/sign-in");
  }

  if (!token) {
    return (
      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-8">
        <h1 className="text-lg font-semibold">First-run setup</h1>
        <p className="mt-3 text-sm text-[color:var(--muted)]">
          This instance has no users yet. The server printed a one-time
          setup URL to stdout on startup — it looks like:
        </p>
        <pre className="mt-3 overflow-auto rounded bg-[color:var(--surface-secondary)] p-3 text-xs">
┌─ SETUP REQUIRED ─────────────────────────────────────────────
│ Open: http://&lt;host&gt;:&lt;port&gt;/setup?token=&lt;uuid&gt;
└──────────────────────────────────────────────────────────────
        </pre>
        <p className="mt-3 text-sm text-[color:var(--muted)]">
          Reload this page with that <code>?token=…</code> appended, or
          tail the server log (<code>journalctl -u aiops</code>,{" "}
          <code>docker logs</code>, or wherever stdout is captured) to
          recover the URL.
        </p>
      </div>
    );
  }

  redirect(`/setup/step/1?token=${encodeURIComponent(token)}`);
}
