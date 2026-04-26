---
title: SECURITY — threat model & defences
status: active
date: 2026-04-26
---

# SECURITY — threat model & defences

LawStack/aiops is a self-hostable single-tenant orchestrator. Its
threat model is shaped by that deployment shape: one box, one
operator team, one set of trusted external integrations. This doc
catalogues the secret material the system handles, who can read it,
how it's protected, and where the protection ends.

## Secret material handled

| What | Where it lives | Encrypted at rest? | Visible to |
|---|---|---|---|
| Jira API tokens (per-user) | `user_prefs.credentials_json` | Yes — AES-256-GCM, AAD bound to userId+fieldPath | Decrypted in process memory during runs |
| GitHub PATs (per-user) | `user_prefs.credentials_json` | Yes — same envelope | Decrypted in process memory during runs |
| Git author identity (per-user) | `user_prefs.credentials_json` | No — non-secret | UI-readable |
| `JIRA_API_TOKEN` (instance default) | `settings.value` | Yes — AES-256-GCM, AAD bound to settings key | Decrypted via `getConfig` |
| `GITHUB_TOKEN` (instance default) | `settings.value` | Yes — same | Decrypted via `getConfig` |
| `AUTH_SECRET` | `settings.value` (or env var) | No — used as HKDF IKM for the at-rest key | Process memory |
| `TOKEN_ENCRYPTION_KEY` (optional) | env var | N/A — IS the key | Process memory |
| Auth.js session cookies | Browser, signed with `AUTH_SECRET` | N/A | User's browser |
| OAuth refresh tokens | `accounts.refresh_token` | No (Auth.js default) | DB |

`AUTH_SECRET` is the master secret. Anyone with `AUTH_SECRET` plus the
SQLite file can decrypt every per-user and instance-default token.

## Encryption envelope

Per-row format (see `server/lib/encryption.ts`):

```
"enc:v1:" + base64url(IV(12) ‖ CIPHERTEXT ‖ TAG(16))
```

- Algorithm: **AES-256-GCM** ([NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf) §5.2.1.1)
- IV: 12 random bytes per encryption (`crypto.randomBytes`)
- Tag: 16 bytes (default for `aes-256-gcm`)
- Key: 32 bytes derived via **HKDF-SHA256** ([RFC 5869](https://datatracker.ietf.org/doc/html/rfc5869))
  - `IKM` = `AUTH_SECRET` (or `TOKEN_ENCRYPTION_KEY` if set)
  - `salt` = `sha256("aiops.token-encryption.v1")` (constant, public)
  - `info` = `"aiops:user_prefs:tokens:aes-256-gcm:v1"` (versioned label)
- AAD: caller-supplied. For per-user creds:
  `"user_prefs:tokens:v1:" + userId + ":" + fieldPath`
  (e.g. `"user_prefs:tokens:v1:U_abc:jira.apiToken"`)
- AAD for instance settings: `"settings:v1:" + KEY`

**Why AAD includes `userId + fieldPath`**: prevents an attacker with
DB-write access from copying user A's `jira.apiToken` ciphertext into
either user B's row or user A's `github.token` field. GCM auth-tag
verification fails on AAD mismatch — surfaced as
`credentials.decrypt_failure` audit + fall-through to instance default.

## Threats and defences

### T1: SQLite file leak (DB exfiltration without box access)

**Threat:** attacker obtains a copy of `data/app.db` (backup leak,
S3 misconfiguration, lost laptop with a pulled DB).

**Defence:** all secret tokens are `enc:v1:` ciphertexts. Without
`AUTH_SECRET` (or `TOKEN_ENCRYPTION_KEY`), the attacker faces 2¹²⁸
work per row to forge a single decryption. AAD-binding to userId
prevents cross-user replay even if they have a single decryption.

**Limits:** non-secret fields are plaintext (Jira `baseUrl`, `email`,
`displayName`, GitHub `login`, git author name/email). These leak
identity but not auth material.

### T2: Box shell access (attacker can read process memory)

**Threat:** attacker gains shell access on the box and can read the
Node process's environment via `/proc/<pid>/environ` or attach a
debugger.

**Defence:** **none** at the encryption layer. The HKDF-derived key
lives in process memory; `AUTH_SECRET` lives in `process.env`; both
are reachable. Decrypted token plaintext is also in memory during
runs and in `getConfig` cache for 30s.

**Mitigations:** OS-level — restrict shell access; harden the deploy
user; log SSH sessions. The threat model assumes the box is trusted.

### T3: Privilege escalation via instance fallback

**Threat:** a low-privilege user has no per-user Jira token and the
resolver falls through to the instance-wide token. If that token
has access to projects the user lacks UI access to, the user can
trigger workflow runs that read/write those projects.

**Defence (audit-not-prevent):** every run records flat columns
`runs.jira_token_source` and `runs.github_token_source` ∈
`{'user','instance',null}`. Admins query
`WHERE jira_token_source='instance'` from `/admin/ops` (the
"Instance fallback (7d)" Stat) and follow up with affected users.

**Limits:** fallback IS automatic — the design choice favours UX
("works without per-user setup") over strict isolation. Admins who
need stricter isolation should narrow the instance Jira token's
project scope at Atlassian's end.

### T4: Cross-row / cross-field ciphertext swap

**Threat:** attacker with DB-WRITE access (rare; usually paired with
T1) copies user A's encrypted token into user B's row, or shifts a
Jira ciphertext into a GitHub field, hoping decryption succeeds.

**Defence:** AAD-binding to `userId + fieldPath` makes both attacks
fail GCM auth-tag verification. Logged as
`credentials.decrypt_failure`. Resolver falls through to instance
default for that field.

### T5: Test-endpoint as credential-stuffing oracle

**Threat:** attacker steals a session and uses
`POST /api/profile/credentials/test/[service]` to validate guessed
tokens for the victim or a fixed target.

**Defences (layered):**
1. **Auth gate** — endpoint requires a valid session.
2. **CSRF** — `Origin` header verified against `AUTH_URL`. 403 on
   mismatch with no audit row (probes don't pollute the log).
3. **Rate limit** — 5 tests/min and 30 tests/hour per (user, service)
   via `server/lib/rateLimit.ts`. 429 with `Retry-After`.
4. **Lockout** — 5 consecutive failures in 1h triggers a 30-min
   lockout per (user, service). [OWASP ASVS V11.1.2](https://owasp.org/www-project-application-security-verification-standard/)
   anti-automation. Audited as `credentials.test_locked_out`.
5. **Sanitised errors** — endpoint returns one of a fixed enum
   (`invalid_credentials`/`forbidden`/`network_error`/`rate_limited`/
   `malformed_input`); never echoes provider response bodies.

### T6: Subprocess env-var leak

**Threat:** the spawned `claude` subprocess has Bash access. If the
parent process accidentally spreads its full env, secrets like
`AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, or unrelated provider keys
leak into Claude's tool reach.

**Defence:** `server/worker/spawnAgent.ts` constructs the child env
from a frozen `CHILD_ENV_ALLOWLIST` and asserts at runtime that no
key outside the allowlist is present. Per-run secrets
(`JIRA_API_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`) come from the
RunContext, not from `process.env` — so the orchestrator's master
key never reaches the subprocess.

### T7: Audit-log secret leak

**Threat:** a token (or substring) ends up in an audit-log payload,
making the audit table itself sensitive.

**Defences:**
- Per-credential audit actions log only `{service, userId, ...}` —
  never the token. `credentials.set` records
  `tokenFingerprint = sha256(token).slice(0,16)` for forensics.
- Errors thrown from `JiraClient` / `GithubClient` pass through
  `redactSecrets` before bubbling — strips `ghp_*`, `github_pat_*`,
  `xoxp-*`, `Authorization: Basic|Bearer …` patterns, and basic-auth-
  shaped base64 substrings.

### T8: Key rotation / lossy `AUTH_SECRET` rotation

**Threat:** operator rotates `AUTH_SECRET` (e.g. forced rotation due
to leak), invalidating the HKDF-derived key and rendering every
existing `enc:v1:` ciphertext unreadable.

**Defence (operational):** set `TOKEN_ENCRYPTION_KEY` (32-byte base64)
explicitly so it can be rotated independently of `AUTH_SECRET`.
Document this as the rotation-stable key. v1 has **no automated
re-encryption** — see "Operational notes" below.

## Operational notes

### Required environment

- `AUTH_SECRET`: **min 32 chars** (zod-enforced in
  `server/lib/config.ts`). Used as the HKDF IKM if
  `TOKEN_ENCRYPTION_KEY` is unset.
- `TOKEN_ENCRYPTION_KEY` *(optional)*: 32 raw bytes, base64-encoded.
  Generate with `openssl rand -base64 32`. Setting this decouples the
  at-rest key from `AUTH_SECRET`.

### First-boot checklist for upgraded installs

After upgrading from a pre-`per-user-tokens` version:

1. `npm run db:migrate` applies SQL migrations (creates
   `user_prefs.credentials_json`, `runs.{jira,github}_token_source`)
   AND chains `db:migrate-secrets` which encrypts existing plaintext
   `JIRA_API_TOKEN` / `GITHUB_TOKEN` settings.
2. Boot the server. If any plaintext secrets remain (e.g. you ran
   migrations out of order), `instrumentation.ts` logs a warning at
   startup with the offending keys.
3. Verify in SQLite: `SELECT key, value FROM settings WHERE key IN
   ('JIRA_API_TOKEN','GITHUB_TOKEN');` — both should start with
   `"enc:v1:"`.

### Audit-log retention

Audit rows are append-only at the schema level (no UPDATE/DELETE in
app code). Retain ≥ 365 days for SOC 2 CC6.1 / ISO 27001 A.9.4.1
expectations on credential-lifecycle events. Today there is **no
automated pruning** — operators must back up + truncate manually.

### Key rotation (deferred to v2)

v1 does NOT implement re-encryption tooling. To rotate
`TOKEN_ENCRYPTION_KEY`:

1. Decrypt all `enc:v1:` rows in `user_prefs.credentials_json` and
   `settings` (where keys ∈ `KNOWN_SECRET_KEYS`) with the OLD key.
2. Set the new key.
3. Re-encrypt with the new key.

This is operationally fragile — recommended approach for v1: have all
users re-enter their credentials post-rotation. v2 will ship a
`db:rotate-key` script.

## What's NOT in scope for v1

- Anthropic API key per user (separate brainstorm)
- Token expiry tracking / proactive renewal alerts
- OAuth 3LO for Atlassian
- GitHub App-based PAT alternative
- External secret store (Vault / AWS SM / SOPS)
- Multi-replica key sync
- Per-team or per-project credential overrides
- Automated re-encryption tooling for key rotation

## References

- [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf) — AES-GCM
- [NIST SP 800-133](https://csrc.nist.gov/pubs/sp/800/133/r2/final) — IKM entropy
- [RFC 5869](https://datatracker.ietf.org/doc/html/rfc5869) — HKDF
- [RFC 5116](https://datatracker.ietf.org/doc/html/rfc5116) — AEAD interface
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP ASVS V11.1.2](https://owasp.org/www-project-application-security-verification-standard/) — anti-automation
- Plan: [docs/plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md](plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md)
- ADR: [docs/adrs/0001-resolver-pattern.md](adrs/0001-resolver-pattern.md)
