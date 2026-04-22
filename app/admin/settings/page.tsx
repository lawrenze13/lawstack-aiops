import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/server/auth/config";
import { SETTINGS } from "@/server/lib/settingsSchema";
import { getConfig } from "@/server/lib/config";
import { SettingsSectionForm } from "@/components/admin/SettingsSectionForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const session = await auth();
  const user = session?.user as { role?: string } | undefined;
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-lg font-semibold">Admins only</h1>
        <p className="mt-2 text-sm text-[color:var(--muted)]">
          Settings are managed by the admin that set up this instance.
        </p>
      </main>
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
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            Configure every knob that used to live in <code>.env</code>.
            Changes are picked up without a restart.
          </p>
        </div>
        <Link
          href="/admin/ops"
          className="text-xs text-[color:var(--muted)] hover:underline"
        >
          ← back to admin ops
        </Link>
      </header>

      <div className="space-y-4">
        {SETTINGS.map((section) => (
          <SettingsSectionForm
            key={section.id}
            section={section}
            initialValues={currentValues}
          />
        ))}
      </div>
    </main>
  );
}
