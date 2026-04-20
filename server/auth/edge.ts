// Edge-compatible Auth.js config used by middleware. Intentionally has NO
// adapter (no DB import) — middleware just needs to verify the JWT cookie
// signed by the full config in ./config.ts. Both configs MUST agree on
// session.strategy + the AUTH_SECRET, otherwise the cookie can't be
// decoded across the boundary.
//
// Pattern documented at https://authjs.dev/guides/edge-compatibility
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { auth: authEdge } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  ],
});
