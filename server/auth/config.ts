import "server-only";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/server/db/client";
import { allowedEmail, users, accounts, sessions, verificationTokens } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { env, ALLOWED_DOMAINS } from "@/server/lib/env";
import { audit } from "./audit";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // JWT strategy is required because middleware (Edge runtime) cannot make
  // DB calls. The Drizzle adapter still persists users/accounts on first
  // sign-in; only the session row is skipped — session state lives in the
  // signed JWT cookie. Middleware in middleware.ts uses the same secret to
  // verify the cookie without touching the DB.
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID ?? "",
      clientSecret: env.AUTH_GOOGLE_SECRET ?? "",
      // Note: Google's `hd` param accepts only ONE domain, so we omit it when
      // multiple domains are allowed and let the user pick. The signIn
      // callback below is the authoritative server-side check.
      authorization: {
        params: {
          ...(ALLOWED_DOMAINS.length === 1 ? { hd: ALLOWED_DOMAINS[0]! } : {}),
          prompt: "select_account",
        },
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
      const domain = email.split("@")[1] ?? "";
      if (!ALLOWED_DOMAINS.includes(domain)) {
        audit({ action: "auth.denied_domain", payload: { email, allowed: ALLOWED_DOMAINS } });
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
    // JWT callback runs first; we copy the DB user.id + role into the token
    // so they're available everywhere (route handlers, middleware, server
    // components) without a DB hit.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? "member";
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        (session.user as typeof session.user & { id: string; role: string }).id =
          (token.id as string) ?? "";
        (session.user as typeof session.user & { id: string; role: string }).role =
          (token.role as string) ?? "member";
      }
      return session;
    },
  },
  events: {
    // Fires once per new user row. Used to promote the very first user to
    // admin (so the setup wizard's operator becomes the first admin
    // without manual SQL) and to burn the setup token so the /setup URL
    // is dead afterwards.
    async createUser({ user }) {
      const userId = user.id;
      if (!userId) return;

      // Count users. If this was the first, promote + burn.
      const total = db.select({ id: users.id }).from(users).all();
      const isFirstUser = total.length === 1 && total[0]!.id === userId;

      if (isFirstUser) {
        db.update(users)
          .set({ role: "admin" })
          .where(eq(users.id, userId))
          .run();
        audit({
          action: "auth.first_admin_promoted",
          actorUserId: userId,
          payload: { email: user.email },
        });

        // Burn the setup token — the /setup URL is no longer valid.
        const { burnSetupToken } = await import("@/server/auth/setupToken");
        burnSetupToken(userId);
      }
    },
  },
  pages: {
    signIn: "/sign-in",
    error: "/sign-in",
  },
});
