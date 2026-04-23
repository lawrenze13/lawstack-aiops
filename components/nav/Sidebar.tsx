import Link from "next/link";
import { Brandmark } from "@/components/brand/Brandmark";
import { SidebarItem } from "./SidebarItem";
import { SidebarFooter } from "./SidebarFooter";
import { NotificationsButton } from "./NotificationsButton";
import {
  IconBoard,
  IconDashboard,
  IconOps,
  IconProfile,
  IconSettings,
} from "./SidebarIcons";

type Props = {
  user: { name?: string | null; email?: string | null; role?: string };
};

/**
 * Primary sidebar — 240px fixed column. Only renders on non-board
 * surfaces (see app/(sidebar)/layout.tsx). Server component so we can
 * read session role directly and pass it down; the only client piece
 * is SidebarItem which needs usePathname for active state.
 *
 * Admin-only items are hidden for non-admin viewers. Handlers still
 * enforce role independently — never trust the UI for auth.
 */
export function Sidebar({ user }: Props) {
  const isAdmin = user.role === "admin";

  return (
    <nav
      aria-label="Primary"
      className="flex h-screen w-60 shrink-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--surface)]"
    >
      {/* Matches every page's top header height (h-14) so the
          border-bottom line continues visually across sidebar → main. */}
      <div className="flex h-14 items-center border-b border-[color:var(--border)] px-4">
        <Link href="/" className="inline-flex" aria-label="Go to board">
          <Brandmark size={22} />
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <SidebarSection>
          <SidebarItem
            href="/dashboard"
            icon={<IconDashboard />}
            label="Dashboard"
          />
          <SidebarItem
            href="/"
            icon={<IconBoard />}
            label="Board"
            exact
          />
          <SidebarItem
            href="/team"
            icon={<IconBoard />}
            label="Team"
            exact
          />
          <SidebarItem
            href="/profile"
            icon={<IconProfile />}
            label="Profile"
          />
        </SidebarSection>

        {isAdmin ? (
          <SidebarSection label="Admin">
            <SidebarItem
              href="/admin/settings"
              icon={<IconSettings />}
              label="Settings"
            />
            <SidebarItem
              href="/admin/ops"
              icon={<IconOps />}
              label="Ops"
            />
          </SidebarSection>
        ) : null}

        <SidebarSection>
          <NotificationsButton />
        </SidebarSection>
      </div>

      <SidebarFooter user={user} />
    </nav>
  );
}

function SidebarSection({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      {label ? (
        <div className="mb-1 px-3 pt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          {label}
        </div>
      ) : null}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
