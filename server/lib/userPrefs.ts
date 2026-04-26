import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { userPrefs } from "@/server/db/schema";
import {
  decrypt,
  type Plaintext,
  type Ciphertext,
} from "@/server/lib/encryption";
import {
  UserCredentialsDisk,
  UserCredentialsMem,
  type UserCredentialsDisk as UserCredentialsDiskType,
  type UserCredentialsMem as UserCredentialsMemType,
  type ServiceKey,
} from "@/server/integrations/credentialsSchema";

// ─── Schemas ────────────────────────────────────────────────────────────────

export const agentPrefSchema = z.object({
  model: z.string().optional(),
  costWarnUsd: z.number().nonnegative().optional(),
  costKillUsd: z.number().nonnegative().optional(),
  /** Operator-supplied text appended verbatim to the agent's built-in
   *  prompt when this agent runs. 500-char cap is a soft guardrail;
   *  longer strings are rejected. */
  promptAppend: z.string().max(500).optional(),
});
export type AgentPref = z.infer<typeof agentPrefSchema>;

export const agentOverridesSchema = z.record(z.string(), agentPrefSchema);
export type AgentOverrides = z.infer<typeof agentOverridesSchema>;

export const notificationsSchema = z.object({
  onComplete: z.boolean().optional(),
  onFailure: z.boolean().optional(),
  onAwaitingInput: z.boolean().optional(),
});
export type Notifications = z.infer<typeof notificationsSchema>;

export type UserPrefs = {
  agentOverrides: AgentOverrides;
  notifications: Notifications;
  /** Decrypted (memory) view of per-service credentials. Empty object
   *  when the user hasn't configured any. Decryption failures fall
   *  through to absent — see Risk #1 in the per-user-tokens plan. */
  credentials: UserCredentialsMemType;
};

const DEFAULTS: UserPrefs = {
  agentOverrides: {},
  notifications: {},
  credentials: {},
};

// ─── Reads ──────────────────────────────────────────────────────────────────

function safeParse<T>(raw: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    const res = schema.safeParse(parsed);
    return res.success ? res.data : fallback;
  } catch {
    return fallback;
  }
}

/**
 * AAD composer for credential subfields. Bound into the GCM auth tag
 * to prevent both cross-user and cross-field ciphertext swap attacks.
 * Mirrors the pattern documented in `docs/adrs/0001-resolver-pattern.md`
 * and the per-user-tokens plan §Encryption envelope.
 */
export function credentialAad(userId: string, fieldPath: string): string {
  return `user_prefs:tokens:v1:${userId}:${fieldPath}`;
}

/**
 * Decrypts the secret subfields of a parsed disk-shape credentials
 * blob. On per-field decryption failure, the field is dropped (and
 * the parent block becomes invalid → also dropped, falling through
 * to instance default at the resolver layer). Errors are swallowed
 * so the caller doesn't have to wrap; the resolver audits separately.
 */
function decryptCredentials(
  userId: string,
  disk: UserCredentialsDiskType,
): UserCredentialsMemType {
  const out: UserCredentialsMemType = {};

  if (disk.jira) {
    try {
      const apiToken = decrypt(
        disk.jira.apiToken as Ciphertext,
        credentialAad(userId, "jira.apiToken"),
      );
      out.jira = { ...disk.jira, apiToken };
    } catch {
      // Skip the jira block entirely — partial creds are useless.
    }
  }

  if (disk.github) {
    try {
      const token = decrypt(
        disk.github.token as Ciphertext,
        credentialAad(userId, "github.token"),
      );
      out.github = { ...disk.github, token };
    } catch {
      // Skip.
    }
  }

  if (disk.git) {
    out.git = disk.git; // Not encrypted.
  }

  return out;
}

/** Returns the user's prefs, or DEFAULTS if no row exists. Never throws. */
export function readUserPrefs(userId: string): UserPrefs {
  try {
    const row = db
      .select({
        agentOverridesJson: userPrefs.agentOverridesJson,
        notificationsJson: userPrefs.notificationsJson,
        credentialsJson: userPrefs.credentialsJson,
      })
      .from(userPrefs)
      .where(eq(userPrefs.userId, userId))
      .get();
    if (!row) return DEFAULTS;
    const credsDisk = safeParse(
      row.credentialsJson,
      UserCredentialsDisk,
      {} as UserCredentialsDiskType,
    );
    return {
      agentOverrides: safeParse(row.agentOverridesJson, agentOverridesSchema, {}),
      notifications: safeParse(row.notificationsJson, notificationsSchema, {}),
      credentials: decryptCredentials(userId, credsDisk),
    };
  } catch {
    return DEFAULTS;
  }
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** Patch shape accepted by writeUserPrefs. Credentials use the *disk*
 *  shape because the caller knows the userId+fieldPath needed for the
 *  AAD-binding done by `server/lib/encryption.ts`'s `encrypt()`. */
export type UserPrefsPatch = {
  agentOverrides?: AgentOverrides;
  notifications?: Notifications;
  credentials?: UserCredentialsDiskType;
};

/**
 * Reads the row, merges the patch (per-top-level-key — patches
 * replace, not deep-merge), serialises, upserts. Credentials patches
 * carry the disk shape (already-encrypted secret subfields); reads
 * return the memory shape (decrypted). This asymmetry is intentional:
 * the encryption AAD requires the userId + fieldPath at the call
 * site, which lives in the save handler, not here.
 */
export function writeUserPrefs(
  userId: string,
  patch: UserPrefsPatch,
): UserPrefs {
  // Read the disk shape directly so we don't double-encrypt on
  // round-trip. We can't reuse readUserPrefs (which decrypts).
  const row = (() => {
    try {
      return (
        db
          .select({
            agentOverridesJson: userPrefs.agentOverridesJson,
            notificationsJson: userPrefs.notificationsJson,
            credentialsJson: userPrefs.credentialsJson,
          })
          .from(userPrefs)
          .where(eq(userPrefs.userId, userId))
          .get() ?? null
      );
    } catch {
      return null;
    }
  })();

  const currentAgentOverrides = row
    ? safeParse(row.agentOverridesJson, agentOverridesSchema, {})
    : {};
  const currentNotifications = row
    ? safeParse(row.notificationsJson, notificationsSchema, {})
    : {};
  const currentCredentials = row
    ? safeParse(
        row.credentialsJson,
        UserCredentialsDisk,
        {} as UserCredentialsDiskType,
      )
    : ({} as UserCredentialsDiskType);

  const nextAgentOverrides = patch.agentOverrides ?? currentAgentOverrides;
  const nextNotifications = patch.notifications ?? currentNotifications;
  const nextCredentials = patch.credentials ?? currentCredentials;

  db.insert(userPrefs)
    .values({
      userId,
      agentOverridesJson: JSON.stringify(nextAgentOverrides),
      notificationsJson: JSON.stringify(nextNotifications),
      credentialsJson: JSON.stringify(nextCredentials),
    })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: {
        agentOverridesJson: JSON.stringify(nextAgentOverrides),
        notificationsJson: JSON.stringify(nextNotifications),
        credentialsJson: JSON.stringify(nextCredentials),
        updatedAt: new Date(),
      },
    })
    .run();

  // Return the post-write *memory* view so callers see what they'd
  // see on a subsequent read.
  return {
    agentOverrides: nextAgentOverrides,
    notifications: nextNotifications,
    credentials: decryptCredentials(userId, nextCredentials),
  };
}

/**
 * Clears one service block (jira | github | git) from the user's
 * credentials. Used by the "Use instance default" toggle and by
 * admin-acting-on-behalf clear actions.
 */
export function clearUserCredentialService(
  userId: string,
  service: ServiceKey,
): void {
  const current = readUserPrefs(userId);
  // Reconstruct disk-shape from memory by re-encrypting? No — easier
  // to read the raw row and just splice out the named key.
  const row = (() => {
    try {
      return (
        db
          .select({ credentialsJson: userPrefs.credentialsJson })
          .from(userPrefs)
          .where(eq(userPrefs.userId, userId))
          .get() ?? null
      );
    } catch {
      return null;
    }
  })();
  if (!row) return; // Nothing to clear.
  const disk = safeParse(
    row.credentialsJson,
    UserCredentialsDisk,
    {} as UserCredentialsDiskType,
  );
  if (!(service in disk)) return; // Already absent.
  const next = { ...disk };
  delete next[service];
  writeUserPrefs(userId, { credentials: next });
  // Use `current` to silence unused-var; it's the snapshot before clear.
  void current;
}

// Re-export types callers commonly need so they don't have to dual-import.
export type {
  UserCredentialsMemType as UserCredentialsMem,
  UserCredentialsDiskType as UserCredentialsDisk,
  ServiceKey,
  Plaintext,
  Ciphertext,
};
