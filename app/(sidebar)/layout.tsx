import { AppShell } from "@/components/nav/AppShell";

/**
 * Sidebar layout — applied to every route in the `(sidebar)` group
 * (/dashboard, /profile, /admin/*). AppShell handles auth redirect,
 * desktop sidebar, and mobile drawer; pages under this group render
 * their own content inside <main>.
 */
export default function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
