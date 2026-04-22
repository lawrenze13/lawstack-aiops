import "server-only";
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

export async function handleSettingsWrite(
  raw: unknown,
  actorUserId: string | null,
): Promise<{ saved: string[]; rejected: Array<{ key: string; error: string }> }> {
  const body = Body.parse(raw);
  const saved: string[] = [];
  const rejected: Array<{ key: string; error: string }> = [];

  for (const [key, value] of Object.entries(body.values)) {
    if (!CONFIG_KEYS.has(key)) {
      rejected.push({ key, error: "unknown config key" });
      continue;
    }
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
