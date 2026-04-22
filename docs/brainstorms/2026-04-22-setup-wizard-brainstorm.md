---
ticket: N/A (internal initiative)
date: 2026-04-22
status: draft
branch: feat/setup-wizard
---

# Setup wizard — ship out of the box

## What we're building

A first-run **Setup Wizard** at `/setup` and an ongoing **/admin/settings** page
that turn multiportal-ai-ops from a "clone + hand-edit `.env` + restart" install
into a browser-driven configuration experience. An operator should be able to:

1. Clone the repo, `npm install`, `npm run dev`.
2. Hit a setup URL printed in the terminal.
3. Walk through a multi-step form that collects **every configurable value**
   currently spread across `server/lib/env.ts`.
4. End up at a working dashboard ready to ingest the first Jira ticket — no
   text-editor step required.

After install, the same configuration surface is editable at
`/admin/settings` for the lifetime of the instance.

## Why this approach

**Audience: technical operators.** The wizard doesn't need to hide ssh or
CLI auth from the user. Its job is to eliminate the treasure hunt through
README / env.ts / Jira admin docs / Google Cloud Console by surfacing every
field, testing it live, and persisting it somewhere the app can read without
a restart.

**SQLite settings table as source of truth.** A new `settings` (key, value,
updated_by, updated_at) table in `data/app.db` stores all configuration.
`server/lib/env.ts` becomes a thin wrapper that reads from the DB with
`process.env` as a fallback (backwards-compatible with today's hand-edited
`.env`) and the zod schema's `.default()` as a final fallback. This lets the
admin edit from the UI without restarting Next.js and keeps secrets inside
the same threat surface as the existing Auth.js session table.

**Setup token bypass for first-run auth.** Google OAuth can't configure
itself. On first boot, if no admin user exists, the server generates a
one-time UUID token, prints it to the terminal as `http://localhost:3300/
setup?token=<uuid>`, and treats that token as authentication for the
`/setup/*` routes only. Once the wizard saves Google OAuth credentials
AND the first real sign-in creates an admin row, the token is burned.

**Everything-configurable wizard.** The first-run flow covers all current
env.ts fields, grouped into steps: (1) Authentication, (2) Jira, (3) Paths &
repo, (4) Agents & costs, (5) Dev preview (optional), (6) Advanced overrides
(branch suffix, Jira status names). The admin clicks through once; nothing
important lives outside this funnel.

**Blocking test buttons per step.** Every step has a "Test this" action
that hits the real external service: Jira creds → `GET /rest/api/3/myself`,
path → `git -C <path> status`, Google OAuth → the authorize-URL shape
check, Claude CLI → `claude --version`. A step can't be marked complete
until its test returns green. Catches typos before they cascade into
confusing runtime errors later.

**Settings-drift banner on upgrade.** When a future code change introduces
a new required setting, boot compares env.ts's schema to the settings table;
if a required key is missing, admins see a banner on their next page load
pointing them at `/admin/settings`. Non-admin users see a maintenance page.
Clear, contained, self-healing.

**Masked secrets with rotate.** After initial save, tokens render as
`••••••••xxxx` (last 4 only) with a "Rotate" button that clears the field
for a fresh value. Prevents shoulder-surfing and accidental screenshot
leaks while still letting the admin recognise which secret they're editing.

## Key decisions

| Decision | Choice |
|---|---|
| Installer audience | Technical operator (ssh/CLI comfortable) |
| Config storage | SQLite `settings` table; `.env` is fallback |
| Bootstrap auth | One-time CLI-printed setup token; expires on OAuth save |
| Wizard scope | Every configurable value (grouped into 5-6 steps) |
| Validation | Live blocking test per step before save-and-continue |
| Upgrade UX | Settings-drift banner in /admin/settings on missing keys |
| Secret display | Masked (last 4) with explicit rotate action |
| Editing later | `/admin/settings` page mirrors the wizard; no re-run of wizard needed |

## Key components (at a glance)

- `server/lib/config.ts` — `getConfig(key)` reads DB first, then `process.env`,
  then zod default. Typed accessors per section.
- `server/lib/settingsSchema.ts` — declarative list of settings sections
  (Authentication / Jira / Paths / Agents / Preview / Advanced), each with
  typed fields (input kind, default, `.test()` function, `.mask` flag). The
  wizard and /admin/settings UI both render from this schema — one source of
  truth.
- `data/app.db` gets a new `settings` table and a `setup_tokens` table
  (single-row with used_at timestamp).
- `app/setup/page.tsx` + `app/setup/step/[n]/page.tsx` — the wizard shell
  and steps.
- `app/admin/settings/page.tsx` — the ongoing editor.
- `instrumentation.ts` (or server startup) — generates the setup token on
  first boot if no admin exists, logs the URL.
- `middleware.ts` — adds a `/setup?token=<uuid>` bypass path.

## Resolved questions

1. **Setup token print location** → `instrumentation.ts` on server startup.
   Runs once per process boot; detects empty users table; generates a UUID,
   persists to `setup_tokens` row, logs the `http://HOST:PORT/setup?token=`
   URL to stdout. Works for both `npm run dev` and production starts.

2. **CLI auth checks (`gh`, `claude`)** → **Yes**, wizard tests both and
   shows login commands on failure. `gh auth status` (exit 0 = ok) and
   `claude --version` (exit 0 = ok) run in a dedicated "CLI prerequisites"
   step with a Retest button. If either fails, the step displays the exact
   terminal command to run (e.g., `gh auth login`, `claude login`) plus
   the reason.

3. **`.env` handling** → **Ignore, cold start**. Every wizard run begins
   with blank fields. Makes the flow explicit about what's being stored
   where (DB, not .env) and avoids confusion from half-migrated state.
   The .env-fallback path in `getConfig()` is for ongoing dev-time
   overrides, not for seeding.

4. **Agent configuration scope** → **Cost caps + model only**, editable
   per agent. Prompts, maxTurns, and permission mode stay in
   `server/agents/registry.ts` (code-owned, versioned, PR-reviewed). UI
   shows a row per agent with two editable fields (warn USD, kill USD) and
   a model-name dropdown populated from a fixed list (`claude-opus-4-7`,
   `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`).

5. **CI workflow yaml step** → **Yes**, final wizard step renders the
   `claude-code-review.yml` contents with a Copy button, a "paste into
   .github/workflows/" reminder, and a Verify action that runs
   `gh workflow view claude-code-review.yml -R <target-repo>` to
   confirm it's landed. Non-blocking — the operator can finish the
   wizard without verifying.

6. **End-to-end install validation** → **`scripts/smoke-install.sh`** plus
   a written `docs/install-checklist.md`. The script boots a fresh
   container, curls the setup token URL, POSTs each wizard step's payload,
   and asserts: (a) an admin user exists, (b) all required settings rows
   are populated, (c) a test task can be created. Checklist covers the
   bits that need a real browser (OAuth redirect, first sign-in, Jira
   cookie check). CI-running the script is a later improvement.

## Deferred / out of scope

- **Multi-tenant / SaaS mode.** Single-workspace only. Each install is its
  own server with its own DB + settings.
- **Postgres option.** SQLite is fine for single-operator through small-team.
  Postgres migration is a separate future initiative if horizontal scaling
  is ever needed.
- **Docker image publishing.** Mentioned as a natural follow-up after the
  wizard ships. Not in this scope.
- **Per-user Jira/GitHub creds.** Today the service account's tokens are
  shared across all users. Per-user tokens is a team-mode feature, not a
  first-run concern.
