import { getConfig } from "@/server/lib/config";

// CSRF defence for state-changing routes. Verifies the request's
// `Origin` header matches the configured `AUTH_URL`. Per the OWASP
// CSRF Prevention Cheat Sheet ("Verifying Origin with Standard
// Headers"), any browser making a cross-origin POST will set Origin
// to the attacker's site — comparing to AUTH_URL catches that.
//
// We allow:
//   - Origin matches AUTH_URL exactly (modulo trailing slash)
//   - Origin === Referer's host (fallback when Origin is absent — rare
//     but happens for some "image" + redirected forms)
//   - In dev (NODE_ENV !== 'production') AND when AUTH_URL is unset,
//     allow any origin so the wizard / first-boot flow doesn't hard
//     fail before AUTH_URL is configured.

export type CsrfResult = { ok: true } | { ok: false; reason: string };

export function checkOriginCsrf(req: Request): CsrfResult {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const expected = (() => {
    try {
      return getConfig("AUTH_URL");
    } catch {
      return undefined;
    }
  })();

  const isProd = process.env.NODE_ENV === "production";

  if (!expected) {
    // Pre-config / wizard window: allow in dev; deny in prod (safer
    // than failing-open on misconfig).
    if (isProd) {
      return { ok: false, reason: "AUTH_URL not configured" };
    }
    return { ok: true };
  }

  const expectedOrigin = stripTrailingSlash(expected);
  if (origin && stripTrailingSlash(origin) === expectedOrigin) {
    return { ok: true };
  }

  // Fallback: some browsers omit Origin on same-origin POST. Accept if
  // Referer's origin matches.
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const refOrigin = `${refUrl.protocol}//${refUrl.host}`;
      if (refOrigin === expectedOrigin) {
        return { ok: true };
      }
    } catch {
      // Malformed Referer — fall through to reject.
    }
  }

  return {
    ok: false,
    reason: origin ? `Origin '${origin}' does not match AUTH_URL` : "Origin header missing",
  };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
