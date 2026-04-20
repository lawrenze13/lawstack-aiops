// Edge-compatible Auth.js config used by middleware. Intentionally has NO
// adapter (no DB import) — middleware just needs to know whether a session
// exists. Full callbacks with DB access live in ./config.ts.
//
// Pattern documented at https://authjs.dev/guides/edge-compatibility
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { auth: authEdge } = NextAuth({
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  ],
  // session.strategy is "jwt" by default here; the cookie set by the full
  // config is the same shape, so middleware can read it.
});
