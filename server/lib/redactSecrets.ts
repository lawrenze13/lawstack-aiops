// Best-effort secret-redaction for error messages and log lines.
// Applied at the boundary where errors thrown from JiraClient /
// GithubClient cross into audit log entries or UI-facing responses.
//
// We redact known token shapes:
//   - GitHub PATs: `ghp_<...>`, `gho_<...>`, `ghs_<...>`, `ghr_<...>`,
//     `github_pat_<...>`
//   - Atlassian API tokens (which are opaque random strings — we
//     don't try to match them directly; instead we strip basic-auth
//     headers wholesale).
//   - Slack legacy tokens: `xoxp-<...>`, `xoxb-<...>` etc.
//   - HTTP `Authorization: Basic <base64>` and `Authorization: Bearer <token>` lines.
//   - Long base64-shaped substrings containing `:` (basic-auth pair).
//
// This is a defence-in-depth pass — the primary defence is to NOT
// include tokens in error messages in the first place. JiraClient and
// GithubClient compose their errors from sanitised fields and pass
// the result through this helper as a final scrub before throw.

// Patterns whose entire match should be replaced with <redacted>.
const FULL_REPLACE_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub PATs (classic + fine-grained).
  /ghp_[A-Za-z0-9_]{20,}/g,
  /gho_[A-Za-z0-9_]{20,}/g,
  /ghs_[A-Za-z0-9_]{20,}/g,
  /ghr_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // OpenAI / Anthropic style.
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
];

// Patterns where the captured prefix is preserved and only the
// trailing secret is redacted.
const PREFIX_PRESERVE_PATTERNS: ReadonlyArray<RegExp> = [
  // Authorization: Basic <base64> — strip the base64 portion.
  /(Authorization:\s*Basic\s+)[A-Za-z0-9+/=_-]{16,}/gi,
  // Authorization: Bearer <token> — strip the token.
  /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

const REDACTED = "<redacted>";

/**
 * Apply known-secret-shape redactions to a string. Returns a fresh
 * string; idempotent (running redactSecrets twice produces the same
 * result as running it once).
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const pattern of FULL_REPLACE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  for (const pattern of PREFIX_PRESERVE_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }
  // Strip raw base64-ish blobs that contain ':' (basic-auth shape:
  // base64(email:token)). Heuristic — runs after the targeted patterns
  // above, so well-formed Authorization headers are already handled.
  out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, (m) => {
    try {
      const decoded = Buffer.from(m, "base64").toString("utf8");
      // Basic-auth pairs are `email:token`; both halves printable.
      if (decoded.includes(":") && /^[\x20-\x7e]+$/.test(decoded)) {
        return REDACTED;
      }
    } catch {
      // Not valid base64 — leave alone.
    }
    return m;
  });
  return out;
}

/** Convenience for wrapping caught errors. */
export function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg);
}
