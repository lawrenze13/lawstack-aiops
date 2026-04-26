---
title: Runbook — per-user tokens
status: active
date: 2026-04-26
---

# Runbook — per-user tokens

How to set, diagnose, and recover from issues with the per-user
credentials feature.

For threat model and design rationale, see
[docs/SECURITY.md](../SECURITY.md). For implementation detail, see
[docs/plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md](../plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md).

## For users

### How to set your Jira credentials

1. Go to `/profile`. Scroll to the **External services** section.
2. In the **Jira credentials** card, fill:
   - **Base URL** — your Atlassian Cloud URL, e.g.
     `https://acme.atlassian.net`
   - **Email** — the email of the Atlassian account you want runs to
     act as
   - **API token** — generate one at
     [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
     paste it here
3. Click **Test connection**. On success, the card shows
   `✓ verified` plus your display name and email as Jira sees them.
4. Click **Save**. The token is encrypted and stored. Reload the page
   to confirm: the card shows `configured` and the saved token is
   masked as `***<last4>`.

After save, every run **you create** uses these credentials when it
hits Jira. Other users' runs are unaffected; they fall back to the
instance default until they configure their own.

### How to set your GitHub PAT

1. Generate a fine-grained PAT at
   [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens):
   - **Repository access** — only the repo configured as `BASE_REPO`
   - **Permissions** — Contents r/w, Pull requests r/w, Metadata read
   - **Expiry** — ≤ 90 days recommended
2. In the GitHub card on `/profile`, paste the token, click **Test
   connection**. The card confirms your `@login` and (if `BASE_REPO`
   is configured) repo access.
3. Click **Save**.

PRs you author will land under this PAT; commits in those PRs will
also be authored as you (see Git identity below).

### How to set your Git author identity

1. Open the **Git author** card on `/profile`.
2. Defaults are pre-filled from your profile name + email. Adjust if
   needed.
3. Click **Save**.

When the worker creates a worktree for a task you own, it runs
`git config --local user.name/user.email` from these values inside
that worktree. Subsequent commits in your tasks reflect your identity
in `git log` — not just on the PR.

### How to fall back to the instance default

Each card has a **Use instance default** link below the inputs (only
visible when you've configured a value). Clicking it `DELETE`s your
override; subsequent runs use the instance default for that service.

### What happens if my token expires?

Mid-pipeline runs will fail with `killed_reason='credentials_invalid:jira'`
(or `:github`). You'll see a notification in the bell icon top-right.
Update the token on `/profile` and re-trigger the failed run.

## For admins

### Diagnosing a `credentials_invalid` failure

1. Open `/admin/ops`.
2. The "Failed runs (last 24h)" panel highlights `credentials_invalid:*`
   reasons with a 🔑 icon.
3. The run row's task → ticket link gets you to the owner. Tell them
   to update their `/profile` Connections.
4. If the **Instance fallback (7d)** Stat is unexpectedly high,
   scrutinise which users are relying on the box's god-token and
   whether their projects need stricter isolation.

### Per-user credential overview

Visit `/admin/users`. The table shows each user's per-service status:
- `instance default` — user has not configured an override
- `✓ configured` — user has set their own; click **Clear** to remove

Token values are never displayed on this page. Clearing requires
confirmation; the audit log records `credentials.cleared` with
`{service, targetUserId, clearedBy: <adminId>}`.

### Investigating a stale audit-log entry

```sql
-- Recent credential operations
SELECT ts, action, actor_user_id, payload_json
FROM audit_log
WHERE action LIKE 'credentials.%'
ORDER BY ts DESC
LIMIT 50;

-- Who has token X (by fingerprint)
SELECT actor_user_id, ts
FROM audit_log
WHERE action='credentials.set'
  AND json_extract(payload_json, '$.tokenFingerprint') = '<16-char hex>'
ORDER BY ts DESC;
```

`credentials.set` audits include `tokenFingerprint` =
`sha256(token).slice(0,16)` — operator forensics without storing the
token itself.

### Forcing the encrypt-at-rest migration

If you upgraded from a pre-encryption version and didn't run the
chained migration:

```bash
npm run db:migrate-secrets
```

Idempotent. Output reports per-key disposition (`encrypted`,
`bootstrapped`, `skipped`, `failed`). Verify:

```sql
SELECT key, substr(value, 1, 7) AS prefix
FROM settings
WHERE key IN ('JIRA_API_TOKEN','GITHUB_TOKEN');
-- Both should be "enc:v1:"
```

The boot-time check (`server/worker/plaintextSecretsCheck.ts`) logs
a warning to stdout on every server start until the migration is run.

### Clearing a user's token on their behalf

From `/admin/users`, click **Clear** on the user's row for the
service. (You can't clear your own from this page — use `/profile`.)
The DELETE call hits
`/api/profile/credentials/[service]?for=<userId>` with admin auth.

### Rotating `TOKEN_ENCRYPTION_KEY`

v1 has **no automated re-encryption tooling.** The supported path:

1. Notify users you're rotating the key — they will need to re-enter
   their tokens.
2. Update the env var on the box and restart.
3. After restart, every existing `enc:v1:` ciphertext fails to
   decrypt → resolver falls through to instance default for each
   user → users see "Re-enter your token" prompts on `/profile`.
4. Have admins manually clear all per-user credentials:

   ```sql
   UPDATE user_prefs SET credentials_json = '{}';
   ```

   (Caution: this is destructive. Make sure you communicated step 1.)

A `db:rotate-key` script that re-encrypts in place is on the v2 list.

### `AUTH_SECRET` rotation

Same caveat: rotating `AUTH_SECRET` without `TOKEN_ENCRYPTION_KEY`
set kills every encrypted blob. **Set `TOKEN_ENCRYPTION_KEY`
explicitly to decouple them.**

## Common errors & fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `/admin/ops` shows `Instance fallback (7d): —` (em-dash) | Migration 0003 not applied | `npm run db:migrate` |
| Boot warning: `WARNING: plaintext secrets detected` | Settings table has plaintext `JIRA_API_TOKEN` or `GITHUB_TOKEN` | `npm run db:migrate-secrets` |
| User can't save Jira creds: "credentials rejected" | Test failed — wrong email + token pair | Verify both were generated under the SAME Atlassian account |
| GitHub Test shows "Token can't access this repo" | PAT scope insufficient | Regenerate as fine-grained PAT with Contents r/w + PR r/w + Metadata read on `BASE_REPO` |
| User's runs all show `jira_token_source='instance'` even after they set credentials | Their saved Jira block is missing fields (e.g. they cleared apiToken) | Have them re-test + save in `/profile` |
| `credentials_invalid:jira` on a user's runs | Their saved Jira token has expired or been revoked | They re-enter on `/profile`. Or admin clears via `/admin/users` to revert to instance default |
| `credentials.decrypt_failure` audit entries | Either `TOKEN_ENCRYPTION_KEY` was rotated, or DB row was tampered with | If rotated: have user re-enter. If tampered: investigate audit_log.actor_ip on the surrounding `credentials.set` |
