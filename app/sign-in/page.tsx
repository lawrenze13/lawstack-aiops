import { redirect } from "next/navigation";
import { signIn } from "@/server/auth/config";
import { ALLOWED_DOMAINS, env } from "@/server/lib/env";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { Brandmark } from "@/components/brand/Brandmark";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{
    from?: string;
    error?: string;
    attempted?: string;
  }>;
};

function formatDomains(): string {
  if (ALLOWED_DOMAINS.length === 0) return "(no domains configured yet)";
  if (ALLOWED_DOMAINS.length === 1) return `@${ALLOWED_DOMAINS[0]}`;
  return ALLOWED_DOMAINS.map((d) => `@${d}`).join(" or ");
}

/**
 * Human-friendly explanation for each NextAuth / signIn-callback error
 * code. Keep the messages specific — the old "rejected" message was
 * symmetrical across all failure modes which made them indistinguishable.
 */
function errorMessage(code: string, attempted: string, domains: string): string {
  const who = attempted ? ` as ${attempted}` : "";
  switch (code) {
    case "DomainNotAllowed":
      return `You signed in${who}, but only ${domains} accounts are allowed on this instance. Pick a different Google account, or ask your admin to add this domain in /admin/settings.`;
    case "NotOnAllowlist":
      return `${attempted || "That account"} is on an allowed domain, but it isn't on the explicit allow-list. Ask your admin to add you.`;
    case "Unverified":
      return `${attempted || "That account"}'s email isn't verified by Google yet — verify it and try again.`;
    case "NoEmail":
      return `Google didn't return an email for that account — can't authenticate without one.`;
    case "Configuration":
      return `OAuth isn't configured yet (or is misconfigured). Visit /setup or /admin/settings to check AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, and AUTH_URL.`;
    case "AccessDenied":
      return `Google rejected the sign-in. If this was unexpected, try revoking the app at https://myaccount.google.com/permissions and try again.`;
    default:
      return `Sign-in failed${who}. Make sure you used your ${domains} account.`;
  }
}

export default async function SignInPage({ searchParams }: Props) {
  const anyUser = db.select({ id: users.id }).from(users).limit(1).all();
  const oauthConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  if (anyUser.length === 0 && !oauthConfigured) redirect("/setup");
  // ALLOWED_EMAIL_DOMAINS defaults to empty on fresh installs (secure
  // default). If the first-admin hasn't walked the wizard yet, bounce
  // them back so they don't get a mysterious rejection on sign-in.
  if (anyUser.length === 0 && ALLOWED_DOMAINS.length === 0) redirect("/setup");

  const sp = await searchParams;
  const from = sp.from ?? "/";
  const error = sp.error;
  const attempted = sp.attempted ?? "";
  const domains = formatDomains();
  const isFirstAdmin = anyUser.length === 0;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] px-6 py-3">
        <Brandmark size={24} />
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {/* Terminal-card */}
          <div className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] shadow-[0_0_0_1px_var(--border)]">
            {/* faux titlebar */}
            <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--accent)]/70" />
              <span className="ml-2 font-mono text-[11px] text-[color:var(--muted)]">
                ~/aiops — sign-in
              </span>
            </div>

            <div className="p-7">
              <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                {isFirstAdmin ? "claim admin access" : "authenticate"}
              </div>

              <h1 className="text-[22px] font-semibold leading-tight tracking-tight">
                {isFirstAdmin
                  ? "First admin sign-in"
                  : "Welcome back, operator."}
              </h1>

              <p className="mt-2 text-sm leading-relaxed text-[color:var(--muted)]">
                {isFirstAdmin ? (
                  <>
                    The OAuth client is wired up. Sign in with a{" "}
                    <code className="font-mono text-[color:var(--foreground)]">
                      {domains}
                    </code>{" "}
                    Google account to become the first admin.
                  </>
                ) : (
                  <>
                    This instance is restricted to{" "}
                    <code className="font-mono text-[color:var(--foreground)]">
                      {domains}
                    </code>{" "}
                    Google accounts.
                  </>
                )}
              </p>

              {error ? (
                <div className="mt-5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {errorMessage(error, attempted, domains)}
                </div>
              ) : null}

              <form
                action={async () => {
                  "use server";
                  await signIn("google", { redirectTo: from });
                }}
                className="mt-6"
              >
                <button
                  type="submit"
                  className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 px-4 py-2.5 text-sm font-medium transition hover:border-[color:var(--accent)]/60 hover:bg-[color:var(--surface-secondary)]"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 48 48"
                    aria-hidden
                  >
                    <path
                      fill="#FFC107"
                      d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
                    />
                    <path
                      fill="#FF3D00"
                      d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
                    />
                    <path
                      fill="#4CAF50"
                      d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
                    />
                    <path
                      fill="#1976D2"
                      d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
                    />
                  </svg>
                  Continue with Google
                  <span className="ml-auto font-mono text-[color:var(--muted)] transition group-hover:text-[color:var(--accent)]">
                    →
                  </span>
                </button>
              </form>

              <div className="mt-6 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
                <span className="relative inline-flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent)]" />
                  <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-[color:var(--accent)] opacity-75" />
                </span>
                orchestrator online
              </div>
            </div>
          </div>

          <p className="mt-6 text-center text-[11px] text-[color:var(--muted)]">
            Need to reconfigure?{" "}
            <a
              href="/setup"
              className="underline decoration-dotted underline-offset-2 hover:text-[color:var(--accent)]"
            >
              Re-run setup
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
