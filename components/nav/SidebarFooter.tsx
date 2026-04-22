import { signOut } from "@/server/auth/config";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IconSignOut } from "./SidebarIcons";

type Props = {
  user: { name?: string | null; email?: string | null };
};

/**
 * Bottom-anchored footer for the sidebar. Shows the current user, a
 * theme toggle, and a sign-out form. Rendered inside the sidebar
 * container which is a client component; sign-out lives here (server
 * action) so the POST doesn't need client-side JS.
 */
export function SidebarFooter({ user }: Props) {
  const label = user.name ?? user.email ?? "operator";
  const initials = label
    .split(/[\s@]+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase())
    .slice(0, 2)
    .join("");

  return (
    <div className="mt-auto border-t border-[color:var(--border)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--surface-secondary)] font-mono text-[11px] font-semibold text-[color:var(--foreground)]"
        >
          {initials || "??"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[color:var(--foreground)]">
            {user.name ?? "—"}
          </div>
          <div className="truncate font-mono text-[10px] text-[color:var(--muted)]">
            {user.email ?? ""}
          </div>
        </div>
        <ThemeToggle />
      </div>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/sign-in" });
        }}
      >
        <button
          type="submit"
          className="flex w-full items-center gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 px-3 py-1.5 text-xs text-[color:var(--muted)] transition-colors hover:border-[color:var(--accent)]/50 hover:text-[color:var(--foreground)]"
        >
          <IconSignOut />
          Sign out
        </button>
      </form>
    </div>
  );
}
