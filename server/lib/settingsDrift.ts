import "server-only";
import { getConfig, type ConfigKey } from "./config";
import { requiredSettingFields, type SettingField } from "./settingsSchema";

export type DriftResult = {
  hasMissing: boolean;
  missing: SettingField[];
};

/**
 * Detect which required settings are unset. A field is "missing" when
 * getConfig returns null/undefined/empty-string — that's the shape
 * every optionalStr() zod entry normalises empty to.
 *
 * AGENT_OVERRIDES_* pseudo-keys (used by the wizard UI to edit a JSON
 * blob) are skipped because they don't map to a single config key.
 */
export function detectSettingsDrift(): DriftResult {
  const missing: SettingField[] = [];
  for (const field of requiredSettingFields()) {
    if (field.key.startsWith("AGENT_OVERRIDES_")) continue;
    const value = getConfig(field.key as ConfigKey, { skipCache: true });
    if (value === null || value === undefined || value === "") {
      missing.push(field);
    }
  }
  return { hasMissing: missing.length > 0, missing };
}
