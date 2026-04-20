import "server-only";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/server/db/client";
import { allowedEmail, users, accounts, sessions, verificationTokens } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { env } from "@/server/lib/env";
import { audit } from "./audit";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "database" },
  trustHost: true,
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID ?? "",
      clientSecret: env.AUTH_GOOGLE_SECRET ?? "",
      // Hint Google to pre-filter to your workspace domain. We still verify
      // server-side; `hd` from Google can be claimed but never trusted alone.
      authorization: {
        params: { hd: env.ALLOWED_EMAIL_DOMAIN, prompt: "select_account" },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile, user }) {
      const email = (profile?.email ?? user?.email ?? "").toLowerCase();
      const emailVerified = (profile as { email_verified?: boolean } | undefined)?.email_verified;

      if (!email) {
        audit({ action: "auth.denied_no_email", payload: { profile } });
        return false;
      }
      if (emailVerified === false) {
        audit({ action: "auth.denied_unverified", payload: { email } });
        return false;
      }
      if (!email.endsWith(`@${env.ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)) {
        audit({ action: "auth.denied_domain", payload: { email } });
        return false;
      }

      // Belt-and-braces: if the allow-list table has any rows, require a
      // match. If it's empty (fresh install), allow any matching domain so
      // the first user can sign in and seed it.
      const anyAllow = db.select({ email: allowedEmail.email }).from(allowedEmail).limit(1).all();
      if (anyAllow.length > 0) {
        const hit = db
          .select({ email: allowedEmail.email })
          .from(allowedEmail)
          .where(eq(allowedEmail.email, email))
          .limit(1)
          .all();
        if (hit.length === 0) {
          audit({ action: "auth.denied_allowlist", payload: { email } });
          return false;
        }
      }

      audit({ action: "auth.signin", payload: { email } });
      return true;
    },
    async session({ session, user }) {
      // Surface the app-level role + id on the session for route handlers.
      if (user) {
        (session.user as typeof session.user & { id: string; role: string }).id = user.id;
        (session.user as typeof session.user & { id: string; role: string }).role =
          (user as { role?: string }).role ?? "member";
      }
      return session;
    },
  },
  pages: {
    signIn: "/sign-in",
    error: "/sign-in",
  },
});
