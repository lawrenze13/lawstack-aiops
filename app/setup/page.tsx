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
      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-8 text-center">
        <h1 className="text-lg font-semibold">Setup token required</h1>
        <p className="mt-2 text-sm text-[color:var(--muted)]">
          Check the server's stdout for the <code>/setup?token=…</code> URL
          that was printed on first boot. Reload this page with that
          token appended.
        </p>
      </div>
    );
  }

  redirect(`/setup/step/1?token=${encodeURIComponent(token)}`);
}
