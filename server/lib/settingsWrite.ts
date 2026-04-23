import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { configSchema, setConfig, type ConfigKey } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Shared handler for both /api/setup/save and /api/admin/settings/save.
// Takes a payload of { [key]: value }, validates each value through the
// config zod schema, and writes via setConfig. Throws on any validation
// failure.
// ─────────────────────────────────────────────────────────────────────────────

const Body = z.object({
  values: z.record(z.string(), z.unknown()),
});

const CONFIG_KEYS = new Set(Object.keys(configSchema.shape));

/**
 * Pre-write normalisation. Fixes common user-input foot-guns before the
 * value hits zod validation or the settings table. Runs for every key
 * even if the wizard/admin UI already validated — belt + braces.
 */
function normaliseValue(key: string, value: unknown): unknown {
  // Trailing slashes on AUTH_URL silently break NextAuth's callback
  // builder (it double-slashes `/api/auth/callback/...`). The wizard +
  // admin UI don't strip them, so we do it here for both surfaces.
  if (key === "AUTH_URL" && typeof value === "string") {
    return value.trim().replace(/\/+$/, "");
  }
  // Auto-mint AUTH_SECRET if the operator left it blank. Installer
  // seeds one into .env but anyone running from source / re-running the
  // wizard can end up with an empty value; avoid the 500 at sign-in time.
  if (
    key === "AUTH_SECRET" &&
    (value == null || (typeof value === "string" && value.trim() === ""))
  ) {
    return randomBytes(32).toString("hex");
  }
  return value;
}

export async function handleSettingsWrite(
  raw: unknown,
  actorUserId: string | null,
): Promise<{ saved: string[]; rejected: Array<{ key: string; error: string }> }> {
  const body = Body.parse(raw);
  const saved: string[] = [];
  const rejected: Array<{ key: string; error: string }> = [];

  for (const [key, rawValue] of Object.entries(body.values)) {
    if (!CONFIG_KEYS.has(key)) {
      rejected.push({ key, error: "unknown config key" });
      continue;
    }
    const value = normaliseValue(key, rawValue);
    try {
      // setConfig validates via the zod schema; we just forward.
      setConfig(key as ConfigKey, value as never, actorUserId);
      saved.push(key);
    } catch (err) {
      rejected.push({ key, error: (err as Error).message });
    }
  }

  return { saved, rejected };
}
