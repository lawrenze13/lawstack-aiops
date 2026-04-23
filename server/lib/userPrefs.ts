import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { userPrefs } from "@/server/db/schema";

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
};

const DEFAULTS: UserPrefs = { agentOverrides: {}, notifications: {} };

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

/** Returns the user's prefs, or DEFAULTS if no row exists. Never throws. */
export function readUserPrefs(userId: string): UserPrefs {
  try {
    const row = db
      .select({
        agentOverridesJson: userPrefs.agentOverridesJson,
        notificationsJson: userPrefs.notificationsJson,
      })
      .from(userPrefs)
      .where(eq(userPrefs.userId, userId))
      .get();
    if (!row) return DEFAULTS;
    return {
      agentOverrides: safeParse(row.agentOverridesJson, agentOverridesSchema, {}),
      notifications: safeParse(row.notificationsJson, notificationsSchema, {}),
    };
  } catch {
    return DEFAULTS;
  }
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export function writeUserPrefs(
  userId: string,
  patch: Partial<UserPrefs>,
): UserPrefs {
  const current = readUserPrefs(userId);
  const next: UserPrefs = {
    agentOverrides: patch.agentOverrides ?? current.agentOverrides,
    notifications: patch.notifications ?? current.notifications,
  };

  db.insert(userPrefs)
    .values({
      userId,
      agentOverridesJson: JSON.stringify(next.agentOverrides),
      notificationsJson: JSON.stringify(next.notifications),
    })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: {
        agentOverridesJson: JSON.stringify(next.agentOverrides),
        notificationsJson: JSON.stringify(next.notifications),
        updatedAt: new Date(),
      },
    })
    .run();

  return next;
}
