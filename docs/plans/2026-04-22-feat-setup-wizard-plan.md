---
title: feat — Setup wizard + /admin/settings
type: feat
status: active
date: 2026-04-22
origin: docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md
---

# Setup wizard + /admin/settings

> Plan origin: **docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md**.
> Every key decision in this plan traces back to a resolved question there;
> references like `(see brainstorm §Key decisions)` point at the source.

## Overview

Turn multiportal-ai-ops from "clone → hand-edit `.env` → restart" into a
browser-driven first-run experience (`/setup`) and an ongoing editor
(`/admin/settings`). A technical operator clones the repo, runs `npm run
dev`, hits a terminal-printed token URL, walks through a 5-6 step form,
and lands on a working dashboard. No text-editor step. All config
edits after install happen in the browser without a restart.

This is not just a UI project: it's a config-substrate refactor.
`server/lib/env.ts` stops being a static object loaded once at boot, and
becomes a thin `Proxy` over a new `getConfig(key)` function that reads
from a DB-backed `settings` table with `process.env` + zod defaults as
fallbacks (see brainstorm §Why this approach — "SQLite settings table as
source of truth").

## Problem statement

**Install friction.** Today, installing the orchestrator is a ~45-minute
treasure hunt:
1. Clone the repo.
2. Read the README; grep `server/lib/env.ts` to find every key.
3. Open Google Cloud Console → create OAuth client → copy client ID +
   secret.
4. Open Jira → find the API token page → generate a token.
5. `ssh` in, `vi .env`, paste everything.
6. Run `npm run db:migrate`, pray it works, hit the dev URL, discover a
   typo, go back to step 5.
7. First sign-in works. Discover you need `gh auth login` and
   `claude login` separately. Go back to a terminal.
8. Still have no idea what `WORKTREE_ROOT` or `JIRA_REVIEW_STATUS`
   should be. Revise.

**Runtime edits require restarts.** Every `.env` change restarts Next.js
— SSE subscribers drop, in-flight runs interrupt, queued work stalls.

**Onboarding is tribal.** Every new install is a one-off. No
self-documenting "is this configured right?" surface. No test-before-save
signal. No rotation UX for secrets. No visibility into which fields are
set / unset / stale.

## Proposed solution

Three coupled pieces (see brainstorm §Key components):

1. **Config substrate**. A `settings (key, value, updated_by, updated_at)`
   table in `data/app.db`. A new `server/lib/config.ts` exposes
   `getConfig(key)` that reads DB → `process.env` → zod default. `env.ts`
   becomes a `Proxy` so every existing `env.X` call site keeps working
   and automatically picks up DB values. An in-memory cache invalidated
   on writes keeps per-access cost submillisecond.

2. **Setup token bootstrap**. On first boot with an empty `users` table,
   `instrumentation.ts` generates a UUID, stores it in a single-row
   `setup_tokens` table, and prints the URL `http://HOST:PORT/setup?
   token=UUID` to stdout. Middleware allows `/setup*` and `/api/setup/*`
   when that token matches. The token burns on first Google sign-in
   that produces an admin user row (see brainstorm §Resolved questions
   #1).

3. **Schema-driven wizard + settings page**. A single declarative
   `settingsSchema.ts` describes every configurable field (kind,
   default, mask, test action, required). Both `/setup/step/[n]` (the
   multi-step wizard) and `/admin/settings` (the flat ongoing editor)
   render from this schema. One source of truth → no drift between the
   two surfaces (see brainstorm §Key decisions).

## Technical approach

### Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Browser                                                       │
│   /setup (token gate) ──┐                                     │
│                         ├── renders <Wizard> from schema      │
│   /admin/settings ──────┘    renders <SettingsPage> from same │
│                              schema                           │
│                   ↓ fetch                                      │
├───────────────────────────────────────────────────────────────┤
│ Next.js routes                                                 │
│   GET  /api/setup/bootstrap      (session gate off, token on)  │
│   POST /api/setup/save?token=X                                 │
│   POST /api/setup/test/:id?token=X                             │
│   POST /api/admin/settings/save  (admin gate)                  │
│   POST /api/admin/settings/test  (admin gate)                  │
│                   ↓                                            │
├───────────────────────────────────────────────────────────────┤
│ server/lib/                                                    │
│   config.ts   ← getConfig/setConfig/invalidateConfig           │
│   env.ts      ← Proxy<EnvShape> forwarding to getConfig()      │
│   settingsSchema.ts ← declarative sections[] × fields[]        │
│                   ↓                                            │
├───────────────────────────────────────────────────────────────┤
│ data/app.db                                                    │
│   settings (key PK, value TEXT JSON, updated_by, updated_at)   │
│   setup_tokens (id=1 single-row, token, created_at, used_at)   │
└───────────────────────────────────────────────────────────────┘
```

### Data model

```sql
-- settings: flat key/value. value is JSON so we can store scalars +
-- arrays + numbers without a column-per-type.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,           -- JSON.stringify(value)
  updated_by TEXT,                    -- users.id of the admin who saved it
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- setup_tokens: single-row table, constraint-enforced. Stores the raw
-- UUID for simplicity (single-operator tool; anyone with DB access
-- has everything already).
CREATE TABLE setup_tokens (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  token      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  used_at    INTEGER                  -- set when first admin signs in
);
```

Drizzle schema additions (`server/db/schema.ts`):

```ts
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const setupTokens = sqliteTable("setup_tokens", {
  id: integer("id").primaryKey(),
  token: text("token").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
});
```

### `server/lib/config.ts`

```ts
type ConfigValue = string | number | boolean | string[] | null;
const CACHE = new Map<string, ConfigValue>();

export function getConfig<K extends keyof EnvSchema>(key: K): EnvSchema[K] {
  if (CACHE.has(key)) return CACHE.get(key) as EnvSchema[K];
  const row = db.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, key)).get();
  let parsed: ConfigValue | undefined;
  if (row?.value) parsed = JSON.parse(row.value);
  else if (process.env[key] != null && process.env[key] !== "") {
    parsed = parseEnvValue(key, process.env[key]!);
  } else {
    parsed = defaultForKey(key);
  }
  CACHE.set(key, parsed);
  return parsed as EnvSchema[K];
}

export function setConfig(
  key: string, value: ConfigValue, by: string | null
): void {
  db.insert(settings).values({
    key, value: JSON.stringify(value), updatedBy: by,
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value: JSON.stringify(value), updatedBy: by,
           updatedAt: new Date() },
  }).run();
  CACHE.delete(key);  // next read repopulates from DB
  audit({ action: "settings.updated", actorUserId: by, payload: { key } });
}
```

`env.ts` becomes:

```ts
// env.ts reshape — the shape + zod defaults stay, but access is lazy.
const schema = z.object({ /* same fields as today */ });
type EnvShape = z.infer<typeof schema>;

export const env = new Proxy({} as EnvShape, {
  get(_t, prop: string) {
    return getConfig(prop as keyof EnvShape);
  },
});
```

All ~40 existing `env.JIRA_BASE_URL` / `env.AUTH_GOOGLE_ID` call sites
are untouched; they just became dynamic reads.

### `server/lib/settingsSchema.ts`

```ts
export type FieldKind =
  | "text" | "password" | "textarea" | "number"
  | "select" | "url" | "email" | "domain-list" | "boolean";

export type SettingField = {
  key: string;                // matches env.ts key
  label: string;
  description: string;
  kind: FieldKind;
  default?: unknown;
  mask?: boolean;             // render •••• last-4 after save
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  test?: {
    label: string;            // "Test Jira credentials"
    action: "jira" | "path" | "oauth-shape" | "cli" | "github-api";
  };
};

export type SettingSection = {
  id: "auth" | "jira" | "paths" | "agents" | "preview" | "ci" | "advanced";
  title: string;
  description: string;
  wizardOrder: number;
  wizardOptional?: boolean;   // shown with a Skip link in wizard
  fields: SettingField[];
};

export const SETTINGS: SettingSection[] = [
  { id: "auth", title: "Authentication", wizardOrder: 1, /* ... */ },
  { id: "jira", title: "Jira", wizardOrder: 2, /* ... */ },
  { id: "paths", title: "Paths & base repo", wizardOrder: 3, /* ... */ },
  { id: "agents", title: "Agents & cost caps", wizardOrder: 4, /* ... */ },
  { id: "preview", title: "Dev preview (optional)", wizardOrder: 5,
    wizardOptional: true, /* ... */ },
  { id: "ci", title: "Target-repo CI workflow", wizardOrder: 6,
    wizardOptional: true, /* ... */ },
  { id: "advanced", title: "Advanced", wizardOrder: 99, /* ... */ },
];
```

Every row is declarative — adding a new field tomorrow = one array
entry + one zod schema addition.

### Wizard UI (built on HeroUI v3 primitives)

```
app/setup/
├── layout.tsx                 — minimal chrome, no auth-required
├── page.tsx                   — redirect based on state:
│                                users empty → /setup/step/1
│                                users present → /sign-in
└── step/
    └── [n]/
        └── page.tsx           — server component that reads
                                 SETTINGS[n-1], passes to <WizardStep>

components/setup/
├── Wizard.tsx                 — stepper shell + progress indicator
├── WizardStep.tsx             — form body for a section
├── FieldInput.tsx             — polymorphic on field.kind →
│                                 HeroUI Input | TextArea | Select | Checkbox
├── MaskedSecret.tsx           — •••• last-4 + "Rotate" Button
├── StepTest.tsx               — "Test this" Button + result chip
└── CIYamlCopyStep.tsx         — final step: yaml in <pre>, Copy +
                                 "Verify in target repo" action
```

**Next.js 15 + HeroUI v3 patterns already in place:**
- `<Modal>` / `<Popover>` / `<Button>` / `<Input>` / `<TextArea>` /
  `<Select>` / `<Chip>` / `<Checkbox>` — all from the recent HeroUI
  migration (see commit history `feat/heroui-migration`).
- Fonts: JetBrains Mono body, IBM Plex Sans display — already wired.
- Accent: electric green. Signal-room aesthetic.
- Theme toggle: already present in header (via `next-themes`).

### Test-action endpoints

```
POST /api/setup/test/jira    { baseUrl, email, apiToken }
  → GET {baseUrl}/rest/api/3/myself with basic auth
  → { ok: true, displayName: "..." } | { ok: false, message: "..." }

POST /api/setup/test/path    { path, mustBeGit?: boolean }
  → fs.stat + (git -C {path} rev-parse --git-dir if mustBeGit)
  → { ok: bool, isGitRepo, message }

POST /api/setup/test/oauth-shape  { clientId, clientSecret }
  → Regex validate client_id ends in .apps.googleusercontent.com
  → Secret length >= 24 chars
  → { ok: bool, message }
  # Cannot actually exchange a token pre-sign-in — be honest.

POST /api/setup/test/cli
  → execFile("gh", ["auth", "status"]) + execFile("claude", ["--version"])
  → { gh: { ok, message }, claude: { ok, message } }
  # On failure, response includes the exact login command

POST /api/setup/test/github-api  { repo }   # e.g. Hosted-Network/multiportal
  → execFile("gh", ["api", `repos/${repo}`, "--jq", ".name"])
  → { ok, message }
  # Used by CI-yaml verify step

POST /api/setup/test/github-workflow  { repo, workflowName }
  → gh workflow view {workflowName} -R {repo}
  → { ok, message }
```

All test endpoints are token-gated when users is empty, admin-gated
otherwise. All fail closed. All return the specific login/fix command on
failure (never just "error").

### Setup token lifecycle (see brainstorm §Resolved questions #1)

```
1. process start → instrumentation.ts
   if (SELECT COUNT(*) FROM users) === 0:
     if no existing setup_tokens row:
       INSERT setup_tokens (id=1, token=UUID(), created_at=now)
     token = row.token
     console.log(`\n┌─ SETUP REQUIRED ─────────────────────────\n│
                  Open: http://${HOST}:${PORT}/setup?token=${token}\n│
                  This URL expires when the first admin signs in.\n└─`)

2. user hits /setup?token=X
   middleware.ts:
     if (path starts with /setup or /api/setup):
       if (users empty AND setup_tokens.token === req.query.token):
         allow without auth
       else:
         return 403 "setup complete or invalid token"

3. wizard completes step 1 (Auth section) → saves OAuth creds to settings
   Next.js reloads auth config → Google OAuth now works
   wizard shows "Sign in with Google" link
   user signs in → Auth.js creates first user with role='admin'
   app/api/auth/[...nextauth] server-side callback:
     if (users table was empty OR this is the setup_tokens.used_at path):
       UPDATE setup_tokens SET used_at = now WHERE id = 1
     token is now burned; any /setup?token=X returns 403

4. wizard continues with normal auth (session cookie)
```

### Settings-drift banner (see brainstorm §Resolved questions — drift)

```ts
// components/admin/SettingsDriftBanner.tsx (server component)
const required = SETTINGS.flatMap(s => s.fields)
  .filter(f => f.required);
const stored = db.select({ key: settings.key }).from(settings).all()
  .map(r => r.key);
const missing = required.filter(f =>
  !stored.includes(f.key) && !process.env[f.key]
);

if (missing.length > 0 && user.role === "admin") {
  return <Banner href="/admin/settings#{missing[0].key}">
    New required setting: {missing[0].label}. {missing.length - 1} more.
  </Banner>;
}

if (missing.length > 0 && user.role !== "admin") {
  return <MaintenancePage contact="admin" />;
}
```

Wired into the root layout so it's visible on every authenticated page.

### `/admin/settings` behavior

- Same FieldInput components as wizard.
- Flat single-page form grouped by section.
- Per-field autosave (debounced 500ms on blur for text; immediate on
  select/checkbox).
- Small per-field "saved N seconds ago" indicator.
- MaskedSecret component: ••••••••xxxx + Rotate Button. Clicking
  Rotate clears the value + re-enables the input.
- Every save writes an audit row (`settings.updated`).

### Agent config shape (see brainstorm §Resolved questions #4)

```ts
// Three settings keys per agent:
agent_ce_work_cost_warn_usd     (number, default 10)
agent_ce_work_cost_kill_usd     (number, default 30)
agent_ce_work_model             (select: claude-opus-4-7 |
                                          claude-sonnet-4-6 |
                                          claude-haiku-4-5-20251001)

// registry.ts reads these via getConfig:
costWarnUsd: getConfig("agent_ce_work_cost_warn_usd") ?? 10,
costKillUsd: getConfig("agent_ce_work_cost_kill_usd") ?? 30,
model: getConfig("agent_ce_work_model") ?? "claude-opus-4-7",
```

Prompts, maxTurns, permissionMode stay in code (registry.ts). UI
surfaces only the 3 knobs per agent.

## Implementation phases

### Phase 1: Config substrate (1 day)

- [ ] `server/db/schema.ts` — add `settings` + `setup_tokens` tables.
- [ ] `server/db/migrate-cli.ts` — new migration file.
- [ ] `server/lib/config.ts` — `getConfig` / `setConfig` /
      `invalidateConfig` with in-memory cache.
- [ ] `server/lib/env.ts` — convert to `Proxy<EnvShape>` forwarding to
      `getConfig`. Preserve zod schema as the source of defaults.
- [ ] `server/lib/settingsSchema.ts` — declarative section + field
      arrays for every env.ts key (13 sections × ~25 fields).
- [ ] `server/agents/registry.ts` — read cost caps + model via
      `getConfig(agent_<id>_cost_warn_usd)` etc. Prompts unchanged.
- [ ] Unit tests for `getConfig` precedence: DB > env > default.
      Mutation via `setConfig` invalidates cache.
- [ ] Deliverable: existing app runs unchanged with no settings rows;
      `setConfig("JIRA_BASE_URL", ...)` visible to next run without
      restart.
- [ ] Exit gate: 28 existing vitest tests still pass + new getConfig
      tests pass; typecheck clean.

### Phase 2: Setup token bootstrap (0.5 day)

- [ ] `instrumentation.ts` — on boot, detect empty users; generate
      UUID if no `setup_tokens` row; log URL to stdout.
- [ ] `middleware.ts` — allow `/setup*` and `/api/setup/*` when
      `users` empty and `?token=X` matches `setup_tokens.token`.
- [ ] Auth.js callback — burn token (`SET used_at = now`) on first
      admin creation.
- [ ] Exit gate: fresh DB boot prints a setup URL; hitting it loads
      the (stub) wizard route without auth; after first admin signs
      in the token is dead.

### Phase 3: Settings API + test actions (0.5 day)

- [ ] `app/api/setup/save/route.ts` — token-gated; saves one section's
      values via `setConfig`.
- [ ] `app/api/setup/test/[id]/route.ts` — dispatches to per-action
      handlers (`jira`, `path`, `oauth-shape`, `cli`, `github-api`,
      `github-workflow`).
- [ ] `app/api/admin/settings/save/route.ts` — admin-gated version.
- [ ] `app/api/admin/settings/test/[id]/route.ts` — admin-gated
      version of test actions.
- [ ] Reuse action handlers across both APIs.
- [ ] Exit gate: curl tests against each test action return the
      expected ok/fail shape.

### Phase 4: Wizard UI (1.5 days)

- [ ] `app/setup/layout.tsx` — minimal chrome, includes theme
      toggle + progress indicator.
- [ ] `app/setup/page.tsx` + `app/setup/step/[n]/page.tsx` — server
      entry + per-step page.
- [ ] `components/setup/Wizard.tsx` — stepper shell, keyboard nav
      (arrow keys + Tab), reads SETTINGS schema, shows "Step 2 of 6"
      indicator.
- [ ] `components/setup/WizardStep.tsx` — form body; per-field
      validation; blocks Next until Test passes (or step is
      wizardOptional).
- [ ] `components/setup/FieldInput.tsx` — HeroUI Input / TextArea /
      Select / Checkbox selected by `field.kind`.
- [ ] `components/setup/MaskedSecret.tsx` — masked + Rotate.
- [ ] `components/setup/StepTest.tsx` — wraps a `/api/setup/test/:id`
      call, shows a Chip with result.
- [ ] `components/setup/CIYamlCopyStep.tsx` — final step, clipboard
      copy + verify action.
- [ ] Post-completion redirect: if the user hasn't signed in yet,
      the wizard shows "Sign in with Google" after step 1 saves;
      sign-in returns them to step 2. On full completion, redirect
      to `/`.
- [ ] Exit gate: manual walkthrough of all 6 steps on a fresh DB
      ends at a working `/` page with tasks being creatable.

### Phase 5: /admin/settings (0.5 day)

- [ ] `app/admin/settings/page.tsx` — admin-only; renders every
      SETTINGS section as a collapsible HeroUI Disclosure.
- [ ] Per-field autosave: debounced on text, immediate on
      select/checkbox. Small "saved Xs ago" indicator.
- [ ] MaskedSecret + Rotate reused.
- [ ] Per-field Test button reused.
- [ ] Exit gate: edit a Jira field → next Jira call picks up the new
      value without restart.

### Phase 6: Settings-drift banner (0.5 day)

- [ ] `components/admin/SettingsDriftBanner.tsx` — server component,
      renders on authenticated routes.
- [ ] Non-admin maintenance page when required settings are missing.
- [ ] Unit tests: drift detection ignores fields present in either
      settings or env.
- [ ] Exit gate: add a new field to SETTINGS without data → banner
      appears for admin, maintenance page for others.

### Phase 7: Install validation (0.5 day)

- [ ] `scripts/smoke-install.sh` — fresh DB, boot server on ephemeral
      port, curl each wizard step, assert DB rows.
- [ ] `docs/install-checklist.md` — human checklist for browser-only
      bits (OAuth redirect, first sign-in).
- [ ] README additions: "Setup" section describing the wizard flow.
- [ ] Exit gate: `bash scripts/smoke-install.sh` exits 0 on a fresh
      clone.

**Total: ~5 days.** Descopable to ~3 days by cutting:
- `/admin/settings` (wizard-only for first release)
- Settings-drift banner (manual bookkeeping)
- Per-step Test actions (save raw; let errors surface at runtime)

## Alternative approaches considered

### Alt 1: Keep `.env` as source of truth, wizard writes to file
Wizard generates a `.env` block and shells `npm run dev` to restart.

**Rejected because:**
- File writes from the Next.js process require awkward fs perms.
- Every save restarts the server — SSE drops, runs interrupted.
- Ownership of `.env` split between wizard + manual edits → drift.

### Alt 2: Postgres for settings (scale-ready)
Use Postgres now instead of SQLite, "future-proofing."

**Rejected because:**
- YAGNI. Single-operator install doesn't need Postgres. Adds another
  dep the operator has to set up during install (chicken-and-egg with
  the wizard itself — how does Postgres URL get configured?).
- SQLite settings table is ~20 rows; read overhead is submillisecond.
- Brainstorm explicitly deferred this (see §Deferred / out of scope).

### Alt 3: Make `env.ts` read from JSON file on disk
`data/config.json` + file watcher.

**Rejected because:**
- File-watch cross-platform is fiddly (inotify vs FSEvents).
- Concurrent writes across multiple Node workers need locking.
- SQLite gives us concurrency + transactions + audit rows for free —
  we're already using it everywhere.

### Alt 4: Skip the wizard, write a polished "setup" CLI
`npx multiportal-setup` prompts interactively in the terminal.

**Rejected because:**
- Google OAuth redirect needs a browser anyway.
- Password input in a terminal is worse UX than a browser form with
  masked fields.
- CLI can't render the CI yaml with a clipboard copy button.
- Brainstorm §Why this approach: "eliminate the treasure hunt."

## System-wide impact

### Interaction graph

Changing `env.ts` from static to Proxy touches the entire server:
- `env.JIRA_BASE_URL` — ~12 call sites in `server/jira/`, `server/worker/`
- `env.AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — `server/auth/config.ts`
- `env.WORKTREE_ROOT` / `BASE_REPO` — `server/git/worktree.ts`
- `env.PREVIEW_DEV_PATH` / `PREVIEW_DEV_URL` / `PREVIEW_DEV_ENABLE_SHELL`
  — `app/api/tasks/[id]/preview/` and `preview-shell/`
- `env.JIRA_START_STATUS` / `JIRA_REVIEW_STATUS` — `server/worker/startRun.ts`
  + `server/git/implementComplete.ts`
- Agent configs — `server/agents/registry.ts` (model + cost caps now
  read via `getConfig("agent_*")`)

Every read becomes a cache hit after the first call per key per
process. Writes via `setConfig` invalidate the cache, so subsequent
reads pick up the change without restart.

### Error & failure propagation

- **`getConfig(key)` with no DB row, no env var, no default** →
  throws `ConfigMissingError`. Consuming code either catches (e.g.
  Jira client returns null) or lets it surface.
- **Settings DB corrupt / JSON parse fail** → log + return `null`,
  proceed with `process.env` fallback. Never crash boot.
- **Setup token collision** (astronomically unlikely but): new UUID
  per boot only if existing row doesn't exist. No mutation of
  existing tokens after creation.
- **Test action timeout** (e.g. Jira unreachable) → step's Test
  button shows amber "timed out" chip; user can choose to proceed
  via a "Skip verification" secondary action (records
  `tested=false` in save payload).

### State lifecycle risks

- **Setup token burned before first admin actually signed in** —
  can happen if the browser closes mid-OAuth. Mitigation: token burn
  is gated on *successful admin creation* in the auth callback, not
  on the `/setup` page leaving.
- **Settings saved for a key that's no longer in SETTINGS** — stale
  rows left around. Mitigation: migration script prunes keys not in
  current schema (admin-confirmed, never auto).
- **In-memory cache divergence across Next.js worker processes** —
  dev mode can spawn multiple workers each with its own cache. If
  one worker writes, others stay stale until their cache line
  evicts. Mitigation: DB triggers → SQLite WAL → short cache TTL
  (30s) as a safety net, or broadcast on a worker-to-worker
  event bus. For single-process production, not an issue.

### API surface parity

- `/setup/*` routes and `/admin/settings/*` routes share the same
  handlers via a common `handleSettingsWrite(section, values,
  actorUserId)` function. Different auth gates, same core logic.
- Test actions are shared identically.
- FieldInput + MaskedSecret + StepTest components are rendered by
  both the Wizard and the Settings page.

### Integration test scenarios

Smoke tests the automated script can't cover:

1. **Fresh install → first task in 5 minutes.** Clone → `npm install`
   → `npm run dev` → paste setup URL → fill wizard → sign in → create
   task MP-0001. Measure wall-clock time.
2. **Settings edit without restart.** On a running instance, edit
   `JIRA_BASE_URL` in `/admin/settings`. Create a new task. Observe
   the Jira fetch uses the new URL. No dev server restart.
3. **Secret rotation.** In `/admin/settings`, click Rotate on Jira
   API token. Input a new value. Save. Existing in-flight run
   continues with old (cached) value; new runs use the new value.
4. **Settings drift on upgrade.** Add a new required field to
   SETTINGS, restart. As an admin, see the banner. As a
   non-admin, see the maintenance page. After admin fills the
   field, both surfaces clear.
5. **Setup token abuse.** Try accessing `/setup?token=wrong` on
   a configured instance → 403. Try on a fresh instance without
   token → 403 (token is required even before admin exists).

## Acceptance criteria

### Functional

- [ ] Fresh DB boot prints a setup URL to stdout exactly once.
- [ ] URL is accessible without auth; wrong/missing token returns 403.
- [ ] Wizard step 1 saves OAuth creds + AUTH_SECRET; Google sign-in
      becomes available in the same session.
- [ ] First sign-in via Google creates an admin user row and burns
      the setup token.
- [ ] Each wizard step's Test button blocks Next until it passes
      (except wizardOptional steps).
- [ ] Wizard completion lands on `/` with a functional Jira task
      creation flow.
- [ ] `/admin/settings` is admin-gated; renders every section;
      per-field autosave works.
- [ ] Secrets render masked with Rotate action.
- [ ] A configured instance redirects `/setup` to `/sign-in`.
- [ ] Settings drift banner appears for admin when a required field
      is missing in the DB + env.
- [ ] Non-admin users see a maintenance page during drift.

### Non-functional

- [ ] `npm run build` clean; zero warnings.
- [ ] `npm run typecheck` clean.
- [ ] All 28 existing vitest tests still pass.
- [ ] New tests: getConfig precedence (DB > env > default), setConfig
      invalidation, setup token gate, drift detection. At least 15 new
      tests.
- [ ] `bash scripts/smoke-install.sh` exits 0 on a fresh clone.
- [ ] getConfig read latency ≤ 1ms (cache hit) / ≤ 10ms (cache miss
      → DB read).
- [ ] Settings page first-load ≤ 300ms on a DB with 50 rows.
- [ ] Masked secret UI never sends the raw secret to the client in
      the initial HTML (server-side masking).

### Quality gates

- [ ] `grep -rE 'process\.env\.' server/` — zero matches (only env
      proxy accesses env; all else via getConfig).
- [ ] `grep -rE "from .env" server/` — exactly one (env.ts itself
      bootstrapping zod).
- [ ] Every settings field has a `label`, `description`, and kind.
- [ ] Every field marked `mask: true` renders as MaskedSecret in
      both wizard and settings.
- [ ] Every test action returns a consistent `{ ok, message, ...}`
      shape.

## Success metrics

- **Time-to-first-task for a new install drops from ~45 min
  (today) to <10 min.**
- **Zero support pings for "how do I configure X?"** — the wizard
  surfaces every field with a description.
- **Secret rotation becomes a click** (vs. sshing in + editing +
  restarting).
- **New required settings roll out without silent breakage** — the
  drift banner surfaces them immediately.

## Dependencies & prerequisites

- HeroUI v3 primitives — **already installed** (see
  `docs/plans/2026-04-22-refactor-heroui-ui-migration-plan.md`,
  landed on `feat/heroui-migration` and to-be-merged).
- Drizzle migrations — already in place, just adding two tables.
- next-themes — already integrated via the HeroUI migration.
- Auth.js v5 + Google OAuth — already configured; we add a
  post-sign-in hook to burn the setup token.
- No new npm dependencies required.

## Risk analysis & mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `env` Proxy breaks TypeScript inference | Low | Medium | Cast Proxy target to `EnvShape`; runtime matches |
| Per-access DB reads are slow | Medium | Low | In-memory cache invalidated on writes |
| Multi-worker cache divergence in dev | Medium | Low | 30s cache TTL OR single-process for dev |
| Setup token leaked via logs | Low | High | Log once at boot; never re-print; delete row after use |
| Secret exposed in initial server HTML | Low | Critical | Server-side mask via `renderFieldValue(field, value)` helper |
| Wizard saves OAuth creds but sign-in fails | Medium | Medium | Step 1 has explicit "try signing in" sub-action; wizard re-enters step 1 on auth failure |
| Drift banner floods every page load | Low | Medium | Cached via server component with `cache()` wrapper |
| Test action hangs | Medium | Low | 10s hard timeout; Skip verification fallback |
| Agent config change corrupts running run | Low | Medium | getConfig cache means in-flight runs keep old values; new runs pick up changes |
| Migrating existing `.env` values to DB | N/A | N/A | Brainstorm §Resolved question #3: cold start, don't migrate |
| setup_tokens constraint collision | N/A | N/A | `CHECK (id = 1)` ensures single-row semantics |

## Resource requirements

- **Engineering**: 1 engineer, ~5 days for full scope. Descopable to
  ~3 days (wizard-only, no /admin/settings, no drift banner).
- **Review**: 1 reviewer. PR includes a screen recording of the
  wizard flow on a fresh DB.
- **Infra**: none (single-process, same SQLite file).

## Future considerations

- **Multi-user settings permissions.** Today all settings are
  admin-only. A future per-section role split (e.g. "finance admin
  sees cost caps only") is schema-compatible — add a `role` field
  per SettingSection.
- **Secret scanning in commits.** Pre-commit hook that greps staged
  files for strings matching any `mask: true` secret value.
- **Settings-as-code export.** "Export my settings as a
  JSON/YAML dump" button for backup + reuse on a new install. The
  mirror "Import" would pair with a setup token flow.
- **Postgres swap.** If/when scaling requires it, the schema maps
  cleanly. Only `data/app.db` path changes; all settings code is
  Drizzle-portable.
- **Docker image publishing** — see brainstorm §Deferred. With the
  wizard in place, Docker becomes "just another shell" the operator
  runs — boot prints URL, they hit it. Clean.
- **Per-team settings.** If we ever multi-tenant, `settings.workspace_id`
  would prefix every key lookup.

## Documentation plan

- [ ] `README.md` — rewrite "Setup" section: `npm install && npm run dev`
      → hit printed URL. Remove the manual .env instructions or keep
      them as an "advanced: env override" appendix.
- [ ] `docs/install-checklist.md` — the human-driven validation steps
      the smoke script can't automate (OAuth redirect, first sign-in).
- [ ] `docs/design/settings-schema.md` — how to add a new setting
      field (update SETTINGS, update env.ts zod schema, optional Test
      action, migration if required).
- [ ] `docs/deploy.md` — systemd unit update: production setup token
      flow (first boot prints URL via `journalctl -u multiportal-ai-ops`).
- [ ] `docs/solutions/setup-wizard-patterns.md` — when this lands,
      capture any gotchas (e.g. the OAuth redirect loop,
      cross-worker cache, rotation UX).

## Sources & references

### Origin

- **Brainstorm document:** `docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md`.
  Key decisions carried forward:
  1. SQLite settings table as source of truth (brainstorm §Key decisions).
  2. Setup token from CLI on first boot (brainstorm §Resolved questions #1).
  3. Schema-driven wizard + /admin/settings rendered from one
     `settingsSchema.ts` (brainstorm §Key components).
  4. Masked secrets with Rotate action (brainstorm §Key decisions).
  5. Cost caps + model only for agents; prompts stay in code
     (brainstorm §Resolved questions #4).
  6. Cold start — don't migrate existing .env values (brainstorm
     §Resolved questions #3).

### Internal references

- Current env.ts: `/var/www/aiops.multiportal.io/server/lib/env.ts`
  — zod schema at lines 17-60, used by ~40 call sites
- Auth config: `server/auth/config.ts` — hook for setup-token burn
- Agent config: `server/agents/registry.ts` — cost caps + model
  now read via getConfig
- Drizzle schema: `server/db/schema.ts` — add settings + setup_tokens
- Middleware: `middleware.ts` — /setup* bypass
- HeroUI primitives: already migrated across `components/` and
  `app/` — see `docs/design/heroui-conventions.md`

### External references

- Next.js 15 instrumentation hook:
  https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
- Auth.js v5 callbacks:
  https://authjs.dev/reference/nextjs#callbacks
- Drizzle migrations:
  https://orm.drizzle.team/docs/migrations

### Related work

- HeroUI migration: `docs/plans/2026-04-22-refactor-heroui-ui-migration-plan.md`
  — delivered the primitive layer this wizard consumes.
- Setup wizard brainstorm: `docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md`.
