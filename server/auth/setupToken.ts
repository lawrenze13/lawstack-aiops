import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { setupTokens, users } from "@/server/db/schema";
import { audit } from "@/server/auth/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Setup token lifecycle.
//
// 1. `ensureSetupToken()` runs from instrumentation.ts on every server
//    boot. If users is empty and no token row exists, it inserts (id=1,
//    token=UUID) and logs the `/setup?token=UUID` URL to stdout.
//
// 2. `validateSetupToken(token)` returns true iff:
//       - users is still empty AND
//       - the setup_tokens row exists with used_at=null AND
//       - setup_tokens.token === token
//    Called from API routes and middleware-adjacent checks.
//
// 3. `burnSetupToken(userId)` marks the token used_at=now. Called from
//    the Auth.js signIn callback the first time an admin user is created.
//
// Single-row semantics: we use id=1 as the PK and rely on INSERT OR
// IGNORE to prevent duplicates. Drizzle doesn't expose CHECK constraints
// in the DSL, so the app-level guard is the only enforcement — callers
// must never manually INSERT additional rows.
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureSetupToken(): Promise<void> {
  const userCount = db.select({ id: users.id }).from(users).limit(1).all();
  if (userCount.length > 0) return; // already bootstrapped

  const existing = db
    .select()
    .from(setupTokens)
    .where(eq(setupTokens.id, 1))
    .get();
  if (existing && existing.usedAt == null) {
    logSetupUrl(existing.token);
    return;
  }
  if (existing && existing.usedAt != null) {
    // Token was used but users is empty? Someone deleted users. Mint a
    // fresh token so the operator can recover.
    const newToken = randomUUID();
    db.update(setupTokens)
      .set({ token: newToken, createdAt: new Date(), usedAt: null })
      .where(eq(setupTokens.id, 1))
      .run();
    logSetupUrl(newToken);
    return;
  }

  // No row yet — mint one.
  const token = randomUUID();
  db.insert(setupTokens).values({ id: 1, token }).run();
  logSetupUrl(token);
}

export function validateSetupToken(token: string | null | undefined): boolean {
  if (!token || token.length < 32) return false;
  const userCount = db.select({ id: users.id }).from(users).limit(1).all();
  if (userCount.length > 0) return false;

  const row = db
    .select()
    .from(setupTokens)
    .where(eq(setupTokens.id, 1))
    .get();
  if (!row || row.usedAt != null) return false;
  return row.token === token;
}

export function burnSetupToken(actorUserId: string | null): void {
  const row = db
    .select()
    .from(setupTokens)
    .where(eq(setupTokens.id, 1))
    .get();
  if (!row || row.usedAt != null) return; // already burned

  db.update(setupTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(setupTokens.id, 1), isNull(setupTokens.usedAt)))
    .run();

  audit({
    action: "setup.token_burned",
    actorUserId,
  });
}

function logSetupUrl(token: string): void {
  // Precedence for the printed URL:
  //   1. AUTH_URL env/config — operator's public URL, if they pre-seeded it
  //   2. HOST + PORT env — set by the installer + systemd unit
  //   3. Next.js default port 3000 as last resort
  const base =
    sanitiseBase(process.env.AUTH_URL) ??
    (() => {
      const host = process.env.HOST ?? "localhost";
      const port = process.env.PORT ?? "3000";
      return `http://${host}:${port}`;
    })();
  const url = `${base}/setup?token=${token}`;
  const callback = `${base}/api/auth/callback/google`;
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "┌─ SETUP REQUIRED ─────────────────────────────────────────────",
      `│ Open: ${url}`,
      "│",
      "│ When asked, paste this into Google Cloud Console under",
      "│ Credentials → OAuth client → Authorized redirect URIs:",
      `│   ${callback}`,
      "│",
      "│ This URL expires when the first admin signs in via Google.",
      "│ Only the person with this URL can configure the orchestrator.",
      "└──────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

function sanitiseBase(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) return null;
  return trimmed;
}
