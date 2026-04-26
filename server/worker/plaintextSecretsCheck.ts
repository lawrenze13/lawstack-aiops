// Boot-time check: warn (do NOT throw) if any settings row matches a
// known-secret config key but is not yet encrypted. The encrypt-in-place
// migration runs explicitly via `npm run db:migrate-secrets`, not on
// boot — but new operators who skip that step deserve a loud reminder.
//
// Called from server/worker/lazy-init.ts during ensureInitialised().

import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import { isCiphertext } from "@/server/lib/encryption";
import { KNOWN_SECRET_KEYS } from "@/server/lib/config";

export function warnIfPlaintextSecrets(): void {
  const offenders: string[] = [];

  for (const key of KNOWN_SECRET_KEYS) {
    try {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .get();
      if (!row?.value) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        // Non-JSON value — also not encrypted; offender.
        offenders.push(key);
        continue;
      }
      if (typeof parsed !== "string" || parsed.length === 0) continue;
      if (!isCiphertext(parsed)) offenders.push(key);
    } catch {
      // DB not ready (shouldn't happen post-init) — silently skip.
    }
  }

  if (offenders.length === 0) return;

  // eslint-disable-next-line no-console
  console.warn(
    `[lawstack-aiops] WARNING: plaintext secrets detected in settings table for: ${offenders.join(", ")}.\n` +
      `  Run \`npm run db:migrate-secrets\` to encrypt them at rest.\n` +
      `  See docs/plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md.`,
  );
}
