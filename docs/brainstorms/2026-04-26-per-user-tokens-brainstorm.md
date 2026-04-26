---
title: Per-User Token Configuration with Instance Fallback
status: active
date: 2026-04-26
topic: per-user-tokens
---

# Per-User Token Configuration with Instance Fallback

Let each user configure their own Jira credentials and GitHub token on
their /profile page. When a run executes against an external service,
use the **task creator's** tokens; if they haven't set them, fall back
to the instance-wide tokens already configured in /admin/settings (and
process.env). Tokens stored encrypted at rest.

## What we're building

### 1. Token scope (v1)

Three new per-user override fields, mirroring the existing
`agentOverrides` overlay pattern in `user_prefs`:

| Field | Instance source today | Per-user override |
|---|---|---|
| `JIRA_BASE_URL` | `settings` table | yes |
| `JIRA_EMAIL` | `settings` table | yes (+ Jira `/myself` confirms canonical identity) |
| `JIRA_API_TOKEN` | `settings` table | yes (encrypted) |
| `GITHUB_TOKEN` | `process.env` → **promoted to `settings` (encrypted) in v1** | yes (encrypted) |
| Git author identity | `git config --global` on the box | yes (`gitName` + `gitEmail` per user) |

**Out of v1:** Anthropic API key, OAuth refresh tokens, any new
service. v1 ships exactly the credentials the orchestrator already
needs to run a CE pipeline end-to-end.

**Why no Anthropic key:** users wanted Jira + GitHub specifically.
Anthropic is its own scope-and-billing question (cost meter, kill
caps, model overrides interact with it) and deserves a separate
brainstorm.

### 2. Storage

Extend `user_prefs` with a new `credentialsJson` text column:

```jsonc
// user_prefs.credentials_json (encrypted-at-rest, AES-GCM)
{
  "jira": {
    "baseUrl": "...",
    "email": "...",          // user-typed; basic-auth pair with apiToken
    "apiToken": "...",       // ENCRYPTED
    "displayName": "...",    // from Jira /myself, populated on Test
    "accountId": "..."       // from Jira /myself, populated on Test
  },
  "github": { "token": "..." },  // token ENCRYPTED
  "git": { "name": "...", "email": "..." }  // worktree git author identity
}
```

**Encryption:** AES-GCM with a 256-bit key. Key source:
`TOKEN_ENCRYPTION_KEY` env var (32 bytes, base64). If unset, derive
from `AUTH_SECRET` via HKDF-SHA256 with a fixed `info` string so the
derivation is stable. Documented bootstrapping in install scripts.

**What gets encrypted:** only the secret fields (`apiToken`, `token`).
Non-secret fields (`baseUrl`, `email`) stored plaintext for ease of
admin support and to keep the encrypted blob small.

**Per-row IV:** a random 12-byte nonce prefixed to each ciphertext.
No key rotation in v1 — documented as a v2 concern.

### 3. Resolver: who-owns-what at runtime

A new pure function:

```typescript
getEffectiveCredentials(userId: string): {
  jira: { baseUrl, email, apiToken } | null,
  github: { token } | null,
}
```

Lookup order per field:
1. `user_prefs.credentials_json` for `userId` (decrypted)
2. instance-wide value from `settings` (Jira) or `process.env` (GitHub)
3. `null` if neither exists

The **`userId` is the task creator**, not the user who triggered the
current run. This is set once on task insert and never changes. Every
worker call site (`server/jira/client.ts`, `server/git/approve.ts`,
`server/git/implementComplete.ts`, `server/jira/amendComment.ts`,
`server/worker/startRun.ts`'s Jira-status writer, intake polling) is
refactored to receive credentials via this resolver instead of reading
`env` directly.

**Intake polling and other system-driven actions** continue to use
instance defaults — there's no "owning user" for those.

### 4. Runtime failure: fail loud

When a Jira/GitHub call returns 401/403:

- The run is marked `failed` with status reason
  `"credentials_invalid:<service>"`.
- The /admin/ops dashboard surfaces the failure with a clear message:
  *"<user>'s <service> token is invalid. They need to update it on
  /profile, or admin can clear it to fall back to instance default."*
- The user gets a notification (existing audit/notification substrate).
- **No auto-fallback to the instance token** — masking a stale user
  token would silently shift cost and audit trail back to the
  instance, defeating the whole feature.

### 5. /profile UI surface

Add a "Connections" section to `/profile`, below the existing agent
overrides. Three cards:

- **Jira** — three inputs (base URL, email, API token). "Test
  connection" hits `/api/profile/credentials/test?service=jira`,
  which calls `/myself` and returns `{ displayName, accountId,
  email }` from Jira's response. On success, the card displays
  "Connected as: &lt;displayName&gt; (&lt;email-from-jira&gt;)" — the
  source of truth for who this token represents. "Use instance
  default" toggle clears all three.
- **GitHub** — single token input (with help-link to GH PAT scopes:
  `repo`, `workflow`). "Test connection" calls `GET /user` then
  `GET /repos/{BASE_REPO}` to validate scope; if `BASE_REPO` is
  unset, only `/user` runs and a warning is shown. "Use instance
  default" toggle clears the token.
- **Git identity** — two inputs: `gitName` (default = `users.name`)
  and `gitEmail` (default = the email from Jira's `/myself` response,
  if available, else blank). Used by the worker to set
  `git config user.name/user.email` in the worktree so commits — not
  just PRs — reflect the task creator. No "Test" button; this is
  purely metadata.

API token inputs are **password-masked** with a "show" eyeball.
Saving any of the three cards requires a successful test where one
exists — a failed test shows the error and disables save. This
prevents storing tokens that we already know won't work.

Admins on `/admin/users` see a column "**Has Jira / GitHub set**"
(boolean only — never decrypted). They cannot read the values; they
can clear them on a user's behalf.

## Why this approach

**Overlay pattern is already established.** `user_prefs.agentOverridesJson`
+ `getAgent(id, {userId})` already implements per-user overlay over
instance defaults. Adding `credentialsJson` is a straight copy-paste
of that pattern. New code lives in a single place
(`getEffectiveCredentials`).

**Task creator owns the task forever** is the simplest mental model.
A ticket has one identity in Jira / Git history; that identity is
whoever opened it. Admin help on a stuck task uses the owner's
tokens, not the admin's — admins are facilitators, not impersonators.
The trade-off (admin can't recover a task whose owner's token expired
without contacting them) is acceptable for v1; v2 can add a "borrow
my token" admin escalation if it becomes a real pain.

**Encryption with instance secret** raises the bar over plaintext
without dragging in a vault. SQLite file leak no longer = token leak.
Documented limitation: anyone with shell access on the box can decrypt
because the key lives on the box too — same threat model as
`AUTH_SECRET` already has.

**Fail loud over silent fallback** keeps the audit signal honest.
When your token breaks, you find out — not the instance bill.

## Key decisions

| Decision | Choice |
|---|---|
| Tokens in scope | Jira (URL + email + token), GitHub token, Git author identity |
| Anthropic key | **Out of v1** — separate brainstorm |
| Storage | `user_prefs.credentialsJson`, encrypted at rest |
| Encryption | AES-GCM, key from `TOKEN_ENCRYPTION_KEY` (or HKDF from `AUTH_SECRET`) |
| What's encrypted | Only secret fields; URLs/emails/names plaintext |
| Runtime owner | Task creator (set on insert, immutable) |
| Resolver | `getEffectiveCredentials(userId)` — overlay → instance → null |
| Failure mode | Fail loud, no auto-fallback to instance |
| UI location | New "Connections" section on `/profile`, three cards: Jira / GitHub / Git identity |
| Jira validation | Hit `/myself`; store + display canonical name + email from response |
| GitHub validation | `/user` + `/repos/{BASE_REPO}`; degrade to `/user`-only with warning if BASE_REPO unset |
| Save validation | Successful test required to save (Jira + GitHub) |
| Instance GH token | Promoted from env-only to `settings`, mirroring Jira |
| Git identity | Worker writes `git config user.name/user.email` per task creator before commit |
| Admin visibility | "Has token: yes/no" only — never decrypt |
| Key rotation | Deferred to v2 |

## Resolved questions

1. **GitHub commit author identity** → **yes, set per-user git config.**
   The Connections card on /profile gains a "Git identity" subsection
   with `gitName` + `gitEmail` fields (default-prefilled from
   `users.name` and `JIRA_EMAIL` if present). Worker `git config
   user.name/user.email` in the worktree before any commit. PR author
   AND commits both reflect the task creator.

2. **Jira email validation** → **fetch from `/myself` on Test
   connection; store displayName + accountId.** The Connections card
   shows "Connected as: &lt;displayName&gt; (&lt;email&gt;)" after a
   successful test, sourced from Jira's response — not the user's
   typed input. Disambiguates multi-account Atlassian users and
   prevents typo'd emails from being saved alongside a working token.

3. **`GITHUB_TOKEN` promoted to `settings`** → **yes, mirror the Jira
   pattern.** Add `GITHUB_TOKEN` to `configSchema`, encrypt at rest
   using the same `TOKEN_ENCRYPTION_KEY`, edit via /admin/settings
   exactly like `JIRA_API_TOKEN`. Per-user override layers on top.
   Consistent UX across both services.

4. **GitHub Test connection call** → **`GET /user` + repo-scope check
   against `BASE_REPO`.** Two-stage validation: confirms token works
   AND has access to the configured base repo. If `BASE_REPO` is
   unset (fresh install), fall back to `/user`-only and surface a
   warning: "Set BASE_REPO in /admin/settings to verify repo
   permissions thoroughly."

## Success criteria

- A non-admin user opens `/profile`, enters their Jira credentials,
  hits "Test connection" → green check → "Save" persists encrypted.
- They create a new ticket; the worker's Jira status transition POST
  uses their token (verified by Jira showing the comment author as
  them, not the instance account).
- They invalidate their token in Atlassian → next run on their task
  fails with `credentials_invalid:jira`, clear actionable error, no
  silent fallback.
- A user who never visits `/profile` continues to work exactly as
  today (instance default applied transparently).
- An admin opens `/admin/users` and sees a per-user "Jira ✓ / GitHub ✗"
  status column without ever seeing token values.
- DB dump → `credentials_json` column contains opaque ciphertext.
- A test-suite test asserts that `getEffectiveCredentials(userId)` for
  a user with no row returns the same shape as instance defaults.

## Scope boundaries (explicitly out)

- **Anthropic API key per user.** Cost-meter / model-override
  interaction is its own design problem. Separate brainstorm.
- **OAuth refresh tokens (Google, GitHub OAuth).** Auth.js already
  manages these; piggybacking them onto this feature conflates auth
  identity with API credentials.
- **Key rotation.** Rotating `TOKEN_ENCRYPTION_KEY` invalidates all
  stored tokens; documented as a "users will need to re-enter" event.
- **External secret store (Vault / SM).** v2 if/when needed.
- **Per-task token override** ("use a different token for this one
  ticket"). YAGNI.
- **Multiple tokens per user per service** ("my prod-jira token + my
  staging-jira token"). YAGNI; one instance, one set.
- **Token expiry tracking / proactive renewal reminders.** Could be
  added later as a polish pass.
- **Audit log of token reads.** Audit log records *writes* (set /
  cleared / tested). Reads are too high-volume to log.

## References

- Existing per-user overlay pattern: `server/lib/userPrefs.ts`
- Existing config substrate: `server/lib/config.ts:30-78`
- Jira call sites: `server/jira/client.ts:12-25`,
  `server/jira/amendComment.ts:27`, `server/worker/startRun.ts:279`,
  `server/git/implementComplete.ts:206`
- GitHub call sites: `server/git/approve.ts:394`,
  `server/worker/spawnAgent.ts:89`
- Profile page today: `app/(sidebar)/profile/page.tsx`,
  `app/api/profile/save/route.ts`
- user_prefs schema: `server/db/schema.ts:326-340`
- Settings test action pattern (mirror for credential test):
  `server/lib/settingsTestActions.ts`

## Estimated scope

- DB migration (add `credentials_json`) → 0.5 day
- Encryption helper (`server/lib/credentialCrypto.ts`) + tests → 1 day
- Promote `GITHUB_TOKEN` to settings + admin/settings UI mirror → 0.5 day
- `getEffectiveCredentials` resolver + refactor of ~6 call sites → 1.5 days
- /profile Connections UI (Jira + GitHub + Git identity cards) → 1.5 days
- Test-connection endpoints (Jira `/myself`, GitHub `/user` + repo scope) → 1 day
- Worker `git config` per-task-creator wiring → 0.5 day
- /admin/users "has token" column → 0.5 day
- Failure surfacing on /admin/ops + notification → 0.5 day
- Tests + docs + install-checklist update → 1 day

**~7 days of focused work** (one engineer). Each phase is independently
shippable; the resolver + refactor (1.5d) is the structural backbone
and could ship behind a feature flag before the UI lands.
