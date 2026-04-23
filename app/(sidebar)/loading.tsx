import { RouteSplash } from "@/components/loading/RouteSplash";

/**
 * Route splash for any page in the sidebar group. The Sidebar layout
 * stays mounted (layouts don't remount on child navigation), so the
 * sidebar + mobile top-bar remain visible while this renders.
 */
export default function SidebarLoading() {
  return <RouteSplash label="page" hint="swapping context…" />;
}
