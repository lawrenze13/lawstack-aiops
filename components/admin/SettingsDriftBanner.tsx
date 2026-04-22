import Link from "next/link";
import { detectSettingsDrift } from "@/server/lib/settingsDrift";

type Props = {
  /** Viewer's role. Non-admins never see the banner. */
  role: string | undefined;
};

/**
 * Admin-only banner that appears on every authenticated page when one
 * or more required settings are unset. Non-admins see the companion
 * MaintenanceGate on the home page instead.
 *
 * Server component — reads config directly. Skips cache so a save on
 * /admin/settings clears the banner on next navigation.
 */
export function SettingsDriftBanner({ role }: Props) {
  if (role !== "admin") return null;
  const { hasMissing, missing } = detectSettingsDrift();
  if (!hasMissing) return null;

  const count = missing.length;
  const preview = missing
    .slice(0, 3)
    .map((f) => f.label)
    .join(", ");
  const more = count > 3 ? ` +${count - 3} more` : "";

  return (
    <div className="border-b border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-4 py-2 text-xs">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <div>
          <span className="font-semibold text-[color:var(--warning)]">
            {count} required setting{count === 1 ? "" : "s"} unset:
          </span>{" "}
          <span className="text-[color:var(--muted)]">
            {preview}
            {more}
          </span>
        </div>
        <Link
          href="/admin/settings"
          className="rounded border border-[color:var(--warning)]/60 px-2 py-0.5 font-medium text-[color:var(--warning)] hover:bg-[color:var(--warning)]/20"
        >
          Fix in Settings →
        </Link>
      </div>
    </div>
  );
}
