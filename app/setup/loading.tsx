import { RouteSplash } from "@/components/loading/RouteSplash";

/**
 * Route splash for any /setup* page. The setup layout stays mounted
 * (wizard chrome stays visible) while the server component resolves.
 */
export default function SetupLoading() {
  return <RouteSplash label="setup" hint="preparing wizard…" />;
}
