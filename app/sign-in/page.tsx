import { redirect } from "next/navigation";
import { signIn } from "@/server/auth/config";
import { ALLOWED_DOMAINS } from "@/server/lib/env";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ from?: string; error?: string }>;
};

function formatDomains(): string {
  if (ALLOWED_DOMAINS.length === 1) return `@${ALLOWED_DOMAINS[0]}`;
  return ALLOWED_DOMAINS.map((d) => `@${d}`).join(" or ");
}

export default async function SignInPage({ searchParams }: Props) {
  // Fresh-install guard: if no users exist yet, Google OAuth isn't configured.
  // Bounce to /setup which shows "check stdout for token URL" instead of a
  // Continue-with-Google button that would only produce a confusing error.
  const anyUser = db.select({ id: users.id }).from(users).limit(1).all();
  if (anyUser.length === 0) redirect("/setup");

  const sp = await searchParams;
  const from = sp.from ?? "/";
  const error = sp.error;
  const domains = formatDomains();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">multiportal-ai-ops</h1>
        <p className="text-sm text-[color:var(--muted)]">
          Sign in with your <span className="font-mono">{domains}</span> Google account.
        </p>
      </header>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
          Sign-in was rejected. Make sure you used your {domains} account.
        </div>
      ) : null}

      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: from });
        }}
      >
        <button
          type="submit"
          className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--surface-secondary)]"
        >
          Continue with Google
        </button>
      </form>
    </main>
  );
}
