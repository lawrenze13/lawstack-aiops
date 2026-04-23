// Edge-compatible Auth.js config used by middleware. Intentionally has NO
// adapter (no DB import) — middleware just needs to verify the JWT cookie
// signed by the full config in ./config.ts. Both configs MUST agree on
// session.strategy + the AUTH_SECRET, otherwise the cookie can't be
// decoded across the boundary.
//
// Providers are intentionally empty here: the full OAuth flow runs under
// the Node runtime in /api/auth/* (see ./config.ts). Including the Google
// provider here would only add a redundant process.env read that can't
// see DB-backed settings — actively misleading when diagnosing auth
// failures. AUTH_SECRET is read from process.env by NextAuth itself.
//
// Pattern documented at https://authjs.dev/guides/edge-compatibility
import NextAuth from "next-auth";

export const { auth: authEdge } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [],
});
