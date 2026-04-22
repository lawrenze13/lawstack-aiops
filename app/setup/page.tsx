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
      <div className="mt-8">
        <div className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] shadow-[0_0_0_1px_var(--border)]">
          {/* faux titlebar */}
          <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--accent)]/70" />
            <span className="ml-2 font-mono text-[11px] text-[color:var(--muted)]">
              ~/aiops — bootstrap
            </span>
          </div>

          <div className="p-8">
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              status · awaiting token
            </div>

            <h1 className="text-[22px] font-semibold leading-tight tracking-tight">
              Setup token required
            </h1>

            <p className="mt-3 text-sm leading-relaxed text-[color:var(--muted)]">
              This instance has no admin yet. The server printed a one-time
              setup URL to stdout on startup. Open that URL (not this page
              directly) to begin the wizard.
            </p>

            <pre className="mt-5 overflow-auto whitespace-pre rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 p-4 font-mono text-[12px] leading-relaxed text-[color:var(--foreground)]">
{`┌─ SETUP REQUIRED ─────────────────────────────────────────────
│ Open: http://<host>:<port>/setup?token=<uuid>
│ This URL expires when the first admin signs in via Google.
│ Only the person with this URL can configure the orchestrator.
└──────────────────────────────────────────────────────────────`}
            </pre>

            <div className="mt-6 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/30 p-4">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                where to look
              </div>
              <ul className="space-y-1.5 text-[13px] text-[color:var(--foreground)]">
                <li className="flex gap-2">
                  <span className="font-mono text-[color:var(--accent)]">
                    $
                  </span>
                  <code className="font-mono text-[12px]">
                    journalctl -u aiops -f
                  </code>
                  <span className="text-[color:var(--muted)]">
                    — systemd service
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-[color:var(--accent)]">
                    $
                  </span>
                  <code className="font-mono text-[12px]">
                    docker logs -f aiops
                  </code>
                  <span className="text-[color:var(--muted)]">
                    — container
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-[color:var(--accent)]">
                    $
                  </span>
                  <span className="text-[color:var(--muted)]">
                    the terminal running <code>npm run dev</code>
                  </span>
                </li>
              </ul>
            </div>

            <p className="mt-5 text-[11px] text-[color:var(--muted)]">
              Lost the URL? Restarting the server on an empty users table
              reprints it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  redirect(`/setup/step/1?token=${encodeURIComponent(token)}`);
}
