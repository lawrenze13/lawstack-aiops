import { detectSettingsDrift } from "@/server/lib/settingsDrift";

type Props = {
  /** Viewer role. Admins always pass through and see the banner instead. */
  role: string | undefined;
  children: React.ReactNode;
};

/**
 * For non-admins: if required settings are unset, replace the page
 * with a maintenance message. Admins always get {children} + see
 * SettingsDriftBanner at the top of the layout.
 *
 * Scope: gate only the user-facing app routes (/, /cards, /team).
 * /admin/* is admin-only anyway; /setup + /sign-in must stay reachable.
 */
export function MaintenanceGate({ role, children }: Props) {
  if (role === "admin") return <>{children}</>;
  const { hasMissing } = detectSettingsDrift();
  if (!hasMissing) return <>{children}</>;

  return (
    <main className="mx-auto max-w-md p-10 text-center">
      <h1 className="text-lg font-semibold">Under maintenance</h1>
      <p className="mt-3 text-sm text-[color:var(--muted)]">
        The administrator hasn&rsquo;t finished configuring this instance.
        Check back once the remaining setup steps are done.
      </p>
    </main>
  );
}
