import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { SETTINGS } from "@/server/lib/settingsSchema";
import { getConfig } from "@/server/lib/config";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { SettingsDriftBanner } from "@/components/admin/SettingsDriftBanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const session = await auth();
  const user = session?.user as { role?: string } | undefined;
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold">Admins only</h1>
        <p className="mt-2 text-sm text-[color:var(--muted)]">
          Settings are managed by the admin that set up this instance.
        </p>
      </div>
    );
  }

  // Load current values for every field. Skip the cache so admins see
  // fresh DB state even if another admin just edited.
  const currentValues: Record<string, unknown> = {};
  for (const section of SETTINGS) {
    for (const field of section.fields) {
      try {
        currentValues[field.key] = getConfig(field.key as never, {
          skipCache: true,
        });
      } catch {
        currentValues[field.key] = null;
      }
    }
  }

  return (
    <div>
      <SettingsDriftBanner role={user.role} />
      <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            admin · settings
          </div>
          <h1 className="text-xl font-semibold">Configuration</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            Configure every knob that used to live in <code>.env</code>.
            Changes are picked up without a restart.
          </p>
        </div>
      </header>

      <SettingsTabs sections={SETTINGS} initialValues={currentValues} />
    </div>
    </div>
  );
}
