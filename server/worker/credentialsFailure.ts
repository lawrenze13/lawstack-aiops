import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { runs } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";
import { redactSecrets } from "@/server/lib/redactSecrets";
import { CredentialsInvalidError } from "@/server/jira/client";
import type { ServiceKey } from "@/server/integrations/credentialsSchema";

// Helpers for the post-implementation Jira/GitHub failure paths in
// approve.ts and implementComplete.ts. When a CredentialsInvalidError
// surfaces, we want:
//   1. The associated run's status flipped to 'failed' with a typed
//      killed_reason so /admin/ops surfaces it with a key-icon hint.
//   2. An audit row of action 'run.failed' so the owning user's
//      notifications panel updates (NOTIFY_ACTIONS in
//      server/lib/notifications.ts already includes run.failed).
//
// `runId` is optional because some failures originate outside a
// concrete run context (e.g. an approve flow that finds no matching
// run); audit still fires in that case.

export type CredentialsFailureReason = `credentials_invalid:${ServiceKey}`;

export function reasonFor(service: ServiceKey): CredentialsFailureReason {
  return `credentials_invalid:${service}` as CredentialsFailureReason;
}

/**
 * Mark a run failed with `credentials_invalid:<service>`. Idempotent:
 * if the run is already failed, just appends an audit row. The error
 * passed in is run through `redactSecrets` before any logging.
 */
export function markRunCredentialsInvalid(opts: {
  runId: string | null;
  taskId: string | null;
  service: ServiceKey;
  err: unknown;
}): void {
  const reason = reasonFor(opts.service);
  const message = opts.err instanceof Error ? opts.err.message : String(opts.err);
  const payload = {
    service: opts.service,
    reason,
    detail: redactSecrets(message),
  };

  if (opts.runId) {
    try {
      db.update(runs)
        .set({
          status: "failed",
          finishedAt: new Date(),
          killedReason: reason,
        })
        .where(eq(runs.id, opts.runId))
        .run();
    } catch {
      // Best-effort — never block the audit / response on DB failure.
    }
  }

  audit({
    action: "run.failed",
    taskId: opts.taskId ?? null,
    runId: opts.runId ?? null,
    payload,
  });
}

/**
 * Convenience guard: tests `err instanceof CredentialsInvalidError`
 * AND returns the typed service key. Used at catch sites that may
 * receive any error type.
 */
export function isCredentialsInvalid(
  err: unknown,
): err is CredentialsInvalidError {
  return err instanceof CredentialsInvalidError;
}
