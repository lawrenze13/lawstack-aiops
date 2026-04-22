import { signIn } from "@/server/auth/config";
import { ALLOWED_DOMAINS } from "@/server/lib/env";

type Props = {
  searchParams: Promise<{ from?: string; error?: string }>;
};

function formatDomains(): string {
  if (ALLOWED_DOMAINS.length === 1) return `@${ALLOWED_DOMAINS[0]}`;
  return ALLOWED_DOMAINS.map((d) => `@${d}`).join(" or ");
}

export default async function SignInPage({ searchParams }: Props) {
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
