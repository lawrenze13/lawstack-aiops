import { auth } from "@/server/auth/config";
import { redirect } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { MobileDrawer } from "./MobileDrawer";
import { Brandmark } from "@/components/brand/Brandmark";

type Props = {
  children: React.ReactNode;
};

/**
 * The shared shell for every non-board route (/dashboard, /profile,
 * /admin/*). Desktop ≥lg: fixed 240px sidebar + flowing content.
 * Mobile <lg: compact top bar with a burger that opens the sidebar
 * as an off-canvas drawer.
 *
 * Server component — runs auth() once and hands the user down to
 * both the Sidebar and the MobileDrawer's inner Sidebar so the role-
 * aware items are rendered on the server.
 */
export async function AppShell({ children }: Props) {
  const session = await auth();
  const user = session?.user as
    | { name?: string | null; email?: string | null; role?: string }
    | undefined;

  if (!user) redirect("/sign-in");

  return (
    // On desktop (lg+) the shell is fixed to the viewport and only the
    // <main> scrolls. On mobile (<lg) the outer height constraint is
    // lifted so the body scrolls normally — the sticky mobile top-bar
    // stays at the top while content scrolls under it.
    <div className="flex lg:h-screen lg:overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden shrink-0 lg:block">
        <Sidebar user={user} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar — sticky so the burger stays reachable.
            Height matches every page's top header (h-14). */}
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--background)]/80 px-4 backdrop-blur lg:hidden">
          <MobileDrawer>
            <Sidebar user={user} />
          </MobileDrawer>
          <Brandmark size={20} />
          <span className="w-9" aria-hidden />
        </header>

        <main className="min-w-0 flex-1 lg:overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
