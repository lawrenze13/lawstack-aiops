---
title: Install checklist
status: active
date: 2026-04-22
---

# LawStack/aiops — install checklist

`scripts/smoke-install.sh` covers the machine-checkable parts of a
fresh install (fresh DB, boot, token, save endpoint, DB write). This
doc covers the **browser-only** bits that cannot be scripted without
real credentials.

---

## Prereqs

- [ ] Node 20 (`nvm use` in repo root picks it up from `.nvmrc`)
- [ ] `openssl` available for `AUTH_SECRET` generation
- [ ] `claude` CLI on `$PATH` (`which claude` returns a binary)
- [ ] Git user configured (`git config user.email`)

## Google OAuth client

Set up ONCE per install in Google Cloud Console:

- [ ] Create (or reuse) an OAuth 2.0 client ID, type **Web application**
- [ ] Authorised redirect URI: `https://<host>/api/auth/callback/google`
      For local dev: `http://localhost:3300/api/auth/callback/google`
- [ ] Note the client ID + client secret — you'll paste them into the
      wizard in step 1

## First-run walkthrough

1. **Run the smoke test first** (optional but fast):
   ```bash
   bash scripts/smoke-install.sh
   ```
   Passes mean the server boots, emits a setup token, and accepts
   saves. If it fails, fix that before trying the wizard in a browser.

2. **Migrate the real DB and start the server:**
   ```bash
   npm run db:migrate    # applies SQL migrations + chains db:migrate-secrets
   npm run dev
   ```

   `db:migrate` now chains `db:migrate-secrets` automatically — it
   encrypts existing plaintext `JIRA_API_TOKEN`/`GITHUB_TOKEN` settings
   in place and bootstraps env-var values into the settings table.
   Idempotent: safe to re-run.

   Optionally set `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`)
   in your env before this step if you want the at-rest key decoupled
   from `AUTH_SECRET` (recommended for production — see
   [`docs/SECURITY.md`](SECURITY.md)).

3. **Grab the setup URL from stdout.** Look for a boxed banner:
   ```
   ╭─────── SETUP REQUIRED ───────╮
   │ Open: http://localhost:3300/ │
   │ setup?token=<uuid>           │
   ╰──────────────────────────────╯
   ```

4. **Walk the wizard:**
   - [ ] **Step 1 · Auth** — paste Google client ID + secret. `AUTH_SECRET`
         can be left blank (a random 32-byte hex is generated on save).
         `AUTH_URL` is pre-filled from the URL you're on right now —
         leave it alone unless you're behind a reverse proxy serving on
         a different origin. Trailing slashes are stripped automatically.
         A live "paste this into Google Cloud Console" panel below the
         fields shows the exact callback URL you need to register —
         **add it to the OAuth client's Authorized redirect URIs before
         clicking Finish**, or sign-in will fail with
         `redirect_uri_mismatch`. `ALLOWED_EMAIL_DOMAINS` defaults to
         empty (deny-all) — fill it with your Workspace domain(s),
         comma-separated.
   - [ ] **Step 2 · Jira** — base URL + email + API token; press Test.
         The chip should flip to green ("connected as …"). Next unlocks.
   - [ ] **Step 3 · Paths** — worktree root + base repo; press Test.
         The chip confirms both paths exist and are writable.
   - [ ] **Step 4 · Agents** — optional cost caps + model override.
         Safe to leave defaults for first install.
   - [ ] **Step 5 · Preview** *(optional)* — local dev URL for preview
         button. Skip if you're not running `bin/dev` on an accessible
         port.
   - [ ] **Step 6 · CI** *(optional)* — copy the workflow YAML into
         your target repo's `.github/workflows/`, press Verify.

5. **Sign in with Google.** The wizard redirects you to
   `/sign-in?from=/setup/...` when you click Finish. First signed-in
   user is auto-promoted to admin and the setup token is burned
   (`setup_tokens.used_at` gets stamped).

6. **Verify:**
   - [ ] Board loads at `/`
   - [ ] Admin link visible in header
   - [ ] `/admin/settings` opens without "admin only" block
   - [ ] `/admin/ops` shows `0 active runs` on a fresh DB
   - [ ] `/dashboard` renders 4 tiles — ops/cost/throughput/activity
         (all zeroes on a fresh install, no empty-state crash)
   - [ ] `/profile` renders four sections — identity, agent defaults,
         notification prefs, **and Connections** (Jira / GitHub PAT /
         Git author identity cards). Each card starts in "instance
         default" state on a fresh install.
   - [ ] `/admin/users` lists all users with per-service "instance
         default" chips (no per-user overrides until users configure
         them on `/profile`).
   - [ ] `/admin/ops` header shows an "Instance fallback (7d)" Stat —
         starts at `0` (or higher once you've run a task or two).
   - [ ] Sidebar is visible on `/dashboard`, `/profile`, `/admin/*`
         but NOT on `/`, `/team`, `/cards/:id`
   - [ ] Hit the setup URL a second time — should redirect to
         `/sign-in`. Token burn confirmed.

## Troubleshooting

- **"SETUP REQUIRED" banner never prints** — usually means a `users`
  row already exists. Either wipe `data/app.db` and re-migrate, or
  delete the row and restart.
- **Google OAuth `redirect_uri_mismatch`** — the redirect URI in
  Google Cloud must match `AUTH_URL` + `/api/auth/callback/google`
  exactly, including scheme and port.
- **`better-sqlite3` native binding error** — wrong Node version. Run
  `nvm use && npm rebuild better-sqlite3`.
- **Jira test fails with `Unauthorized`** — API tokens are tied to
  the email address they were generated under. Confirm the email +
  token were generated in the same Atlassian account.
- **`/admin/ops` shows "Instance fallback (7d): —"** — the 0003
  migration didn't run. Re-run `npm run db:migrate`. The dash will
  flip to a real number on next refresh.
- **Boot warning: `WARNING: plaintext secrets detected in settings`** —
  someone seeded a plaintext token directly. Run
  `npm run db:migrate-secrets` to encrypt in place. Idempotent.
- **Run fails with `killed_reason='credentials_invalid:jira'`** — the
  task owner's Jira token is invalid (or the instance default if
  they haven't set one). They re-enter on `/profile`. See
  [`docs/runbooks/per-user-tokens.md`](runbooks/per-user-tokens.md).

## Post-install monitoring

- `grep "SETUP REQUIRED" /var/log/aiops.log` — should return 0 hits on
  a healthy install
- `sqlite3 data/app.db 'SELECT COUNT(*) FROM setup_tokens WHERE used_at IS NULL;'`
  should be 0 after first admin signs in
- `/admin/settings` shows no drift banner when required fields are set
