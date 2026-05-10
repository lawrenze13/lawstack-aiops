# LawStack/aiops — agent onboarding

> Read this top-to-bottom before touching code. It is the densest path
> from "I just opened this repo" to "I can ship a change without
> guessing." Sections build on each other: the data model explains the
> pipeline; the pipeline explains the file layout; the file layout
> tells you which directory to open next.

## What this app is

An **operator console for Claude Code** that drives the **Compound
Engineering pipeline** (brainstorm → plan → review → implement) on
Jira tickets. One Next.js process, one SQLite file, one server. Each
ticket becomes a card on a Trello-style swimlane board. Each lane is
powered by a swappable Claude agent that runs server-side via
`child_process.spawn('claude', ...)`. Output streams live to the
browser over SSE; final artifacts get committed and pushed by the
server, then a draft PR opens and Jira is notified.

It replaces a previous Slack + n8n flow. There is no parallel
operation — Slack is fully retired.

**Repo:** `lawrenze13/lawstack-aiops` (this directory:
`/var/www/aiops.lawrenzem.space`).
**Production target:** small team (2-10), single VPS, behind Caddy.
**Auth:** Google OAuth via `next-auth`, restricted to allow-listed
email domains.

## Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20 (pinned via `.nvmrc`) | better-sqlite3 native binding |
| Framework | Next.js 15 App Router, TypeScript strict, `"type": "module"` | One process for UI + API + worker |
| Auth | Auth.js v5 (`next-auth@5.0.0-beta.25`) + `@auth/drizzle-adapter` + Google | Domain-restricted via wizard |
| DB | better-sqlite3 + Drizzle ORM, WAL mode, file at `./data/app.db` | Single-process; no Postgres / Redis |
| UI | HeroUI v3 + Tailwind v4 + dnd-kit + react-markdown + remark-gfm | Swimlane drag-drop + markdown viewers |
| Streaming | SSE (`ReadableStream` in App Router) | Unidirectional server→browser |
| Agent runner | `child_process.spawn('claude', ...)` with stream-json output | Reuses the already-proven Claude CLI |
| Tests | Vitest | `npm test` runs `tests/*.test.ts` |
| Prod proc mgmt | systemd + Caddy (full mode); pidfile + nohup (local mode) | See `scripts/install.sh` |

## How to run it locally

```bash
nvm use                  # Node 20 from .nvmrc
npm install
npm run db:migrate       # creates ./data/app.db, runs server/db/migrations
npm run dev              # http://localhost:3300
```

On first boot you'll see a `SETUP REQUIRED` banner with a tokenised
`/setup?token=…` URL. Open it to walk the 6-step wizard. The wizard
writes Google OAuth, Jira, paths, agents, preview, CI config into the
`settings` table — no `.env` required for app config.

```bash
npm run typecheck        # tsc --noEmit
npm run build            # production build
npm test                 # vitest run
npm run db:studio        # drizzle-kit studio (DB inspector)
npm run dev:fresh        # nuke ./data/app.db and reboot the wizard flow
```

If you see `NODE_MODULE_VERSION` errors: wrong Node. Run `nvm use` and
`npm rebuild better-sqlite3`.

## The mental model — read this once, refer back forever

### Lanes (the pipeline)

A task is a card. It moves through a fixed sequence of lanes:

```
ticket → branch → brainstorm → plan → review → pr → implement → done
```

- **ticket** — card just created (Jira key recorded, no work yet).
- **branch** — git worktree provisioned, branch `<KEY>-ai` created.
- **brainstorm** — `ce:brainstorm` agent writes
  `docs/brainstorms/<KEY>-brainstorm.md`.
- **plan** — `ce:plan` agent writes
  `docs/plans/<KEY>-plan.md`.
- **review** — `ce:review` agent validates the plan against the real
  codebase, writes `docs/reviews/<KEY>-review.md`, ends with verdict
  `READY | AMEND | REWRITE`.
- **pr** — operator clicks **Approve & PR**: server commits
  artifacts, pushes, opens draft PR via `gh`, posts "PR opened" Jira
  comment.
- **implement** — `ce:work` agent (Opus) writes real code in the
  worktree, leaves it uncommitted, emits a structured
  `docs/implementation/<KEY>-implementation.md` ship-note.
- **done** — operator clicks **Approve Implementation**: server
  commits + pushes the implementation, rewrites the PR description
  via `gh pr edit --body-file`, posts a richer Jira comment, transitions
  the Jira ticket to "Code Review".

**Auto-advance** runs between lanes (brainstorm → plan → review)
without operator intervention. There are exactly **two manual
gates**: `Approve & PR` (review → pr) and `Approve Implementation`
(implement → done).

A **cycle** is one full pass `brainstorm → … → done`. After cycle 1 a
task can re-enter the pipeline (e.g. via the **QA-fix loop**) — that
is cycle N>1. See `server/lib/taskCycle.ts`. Cycle starts and ends
are derived from audit-log rows, not denormalised columns.

### Agents (the swappable workers)

Each lane has a default agent + a small library of alternates. Agents
are TypeScript config objects in `server/agents/registry.ts`. Each
exports:

- `id` (e.g. `ce:brainstorm`)
- `lanes` it supports
- `model` (e.g. `claude-sonnet-4-6` for planning, `claude-opus-4-7`
  for `ce:work`)
- `maxTurns`, `costWarnUsd`, `costKillUsd`
- `permissionMode` — `acceptEdits` (default) or `bypassPermissions`
  (only `ce:work`, which needs Bash for tests/builds)
- `buildPrompt(ctx)` — function that constructs the agent's prompt
  from `PromptContext` (jiraKey, title, description, priorArtifacts,
  recentCommits, jiraComments, priorReviewCount, interactive flag, …)

**At launch:**
- `ce:brainstorm`, `ce:research` — Brainstorm lane
- `ce:plan` — Plan lane
- `ce:review`, `security:review`, `perf:review`, `deploy:check` —
  Review lane (only the first is gating; others are supplementary)
- `ce:work` — Implement lane
- `test:playwright` — Test lane

**Runner types.** Agents declare a `runnerType` discriminator:
`"claude"` (default) forks `claude -p ...` and pays token cost.
`"script"` forks a plain Node script via `tsx <agent.script>` —
no LLM, no cost meter, no prompt. The dispatcher in
`server/worker/spawnAgent.ts` routes by type. Both paths share
`runRegistry` (Stop button), the serialise-chain mutex
(`serializeKey`), and the post-exit `finalize` chain (artifact
persistence, testComplete, autoAdvance). Today only
`test:playwright` uses `runnerType: "script"` (script:
`scripts/run-playwright.ts`); the operator can override the
script path globally via `TEST_RUNNER_SCRIPT` config.

**Operator overrides:** instance-wide via the `AGENT_OVERRIDES` JSON
blob in `settings`; per-user via `user_prefs.agent_overrides_json`.
Both overlay on the registry default. Prompts, `maxTurns`, and
`permissionMode` stay code-owned (PR-reviewed) — only `model`,
`costWarnUsd`, `costKillUsd`, and an additive `promptAppend` can be
tweaked at runtime.

### Artifacts (drafts in DB; commits on approval)

Every agent run writes a markdown file under `docs/<lane>s/` inside
the worktree. The server scrapes the file via
`server/worker/persistArtifacts.ts` and stores it as an `artifacts`
row keyed to the `runId` + `taskId`. The file in the worktree is
**never committed** until the operator clicks Approve.

Artifact `kind` is one of: `brainstorm`, `plan`, `review`,
`implementation` (the four core CE artifacts), plus supplementary
`research`, `security-review`, `perf-review`, `deploy-check`.

**Staleness** (`is_stale`): when an upstream artifact is rerun, the
downstream artifact is auto-flagged stale so Approve & PR refuses
until the operator re-runs.

**Approval** stamps `is_approved=1`, `approved_by`, `approved_at`.

### Jira / GitHub side effects

| Action | Side effect |
|---|---|
| First user-initiated run on a task | Auto-assign Jira ticket if unassigned, transition to `JIRA_START_STATUS` (default "In Progress"). One-shot via audit dedupe. |
| Approve & PR (cycle 1) | Commit artifacts, push branch, `gh pr create --draft`, post "PR opened" Jira comment with link. |
| Approve & PR (cycle N>1) | Same artifacts → same branch (rebase/push), reuse the existing PR (via `gh pr list`). NO Jira comment yet — deferred to implementComplete. |
| `ce:work` finishes | (Just exits; no side effect until operator approves.) |
| Approve Implementation | Commit + push residual work, `gh pr ready` to flip out of draft, **`gh pr edit --body-file` to rewrite description with the ship-note**, post the implementation Jira comment with the same body, transition to `JIRA_REVIEW_STATUS` (default "Code Review"), set `tasks.currentLane='done'`. |

The implementation handoff is rendered by a single function
`buildImplementationShipNote()` in `server/jira/shipNote.ts`. It
parses `implementation.md` for the four required sections — `##
Summary`, `## User-visible changes`, `## Risk areas`, `## Test Plan`
— plus optional `## Files Touched`, `## Out of scope`, `## Migration
notes`, `## Rollback`. It returns BOTH an ADF document (for the Jira
API) and a markdown string (for `gh pr edit`), byte-identical
content. Cycle N>1 swaps the heading to "QA fix pushed — round N".

If a section is missing, the renderer fills it with a placeholder
("_Test Plan section not provided by the agent — see the diff for
details._"). It does NOT block the approval. Heading match is
case-insensitive substring on a strict allowlist (h2 OR h3) — see
`REQUIRED_SECTIONS` and `OPTIONAL_SECTIONS` in `shipNote.ts`. Don't
relax the allowlist; it would silently merge unrelated agent
content into the QA contract.

### Cost guardrails

Each run emits a cumulative cost into `costMeter.ts` from the
stream-json `usage` events. At `costWarnUsd` the run flips to
`status='running'` with a warning event. At `costKillUsd` the run is
SIGTERMed (5s grace → SIGKILL) and `status='cost_killed'`. Defaults
$5 / $15 globally; `ce:work` is bumped to $10 / $30 in the registry.

## Data model — the schema map

All tables live in `server/db/schema.ts` (Drizzle). Migrations under
`server/db/migrations/`.

### Auth.js v5 tables (managed by `@auth/drizzle-adapter`)
`users`, `accounts`, `sessions`, `verification_tokens`. App-level
`users.role` ∈ `{admin, member, viewer}`; first signed-in user
auto-promotes to admin (`server/auth/config.ts`).

`allowed_email` — belt-and-braces second gate beyond the domain
check. Admins can disable a specific email even if the domain still
matches.

### Domain tables

| Table | Purpose |
|---|---|
| `tasks` | One row per ticket. `currentLane`, `currentRunId`, `jiraKey`, `ownerId`. `UNIQUE(jiraKey)` only while `status='active'` — archive frees the key. |
| `agent_config` | Cache of the registry. `configHash` lets the sync detect drift on boot (`server/agents/sync.ts`). Each `runs` row pins the FULL snapshot in `agentConfigSnapshotJson` so historical inspection survives registry edits. |
| `runs` | One row per agent invocation. Lifecycle: `running` → `completed`/`failed`/`stopped`/`cost_killed`/`interrupted`/`awaiting_input`. `claudeSessionId` is the Claude CLI session for `--resume`. `lastAssistantSeq` + `lastHeartbeatAt` + `supersededAt` drive crash recovery and dedupe. `costUsdMicros` is integer math (no float drift). |
| `messages` | One row per stream-json event from Claude. `seq` is monotonic per run and doubles as SSE event id for `Last-Event-ID` replay. `type` ∈ `{system, assistant, user, stream_event, result, server}`. |
| `artifacts` | Markdown drafts. Keyed by `runId` + `taskId` + `kind`. `is_approved`, `is_stale`, `supersedesId` track lifecycle. Approve & PR reads the latest non-stale artifact per kind. |
| `worktrees` | One row per task's git worktree. `path` is the on-disk dir under `WORKTREE_ROOT`. `status='live'` until pruned. Daily cron in `server/cron/nightly.ts` removes orphans. |
| `pr_records` | One row per task once a PR has opened. `state` is the cycle-1 step machine (`drafting → committed → pushed → pr_opened → jira_notified` plus `failed_at_*`). Cycle N>1 reuses the same row, doesn't touch `state`. |
| `audit_log` | Append-only log of every effect-having action. Used for cycle counting, dedupe (e.g. "did we already transition Jira?"), and the activity feed. Composite index on `(taskId, action)` is load-bearing — see migration 0003. |
| `settings` | Wizard-backed config. JSON-encoded `value`. **Never** read directly — go through `getConfig(key)` in `server/lib/config.ts`. Precedence: settings row → `process.env` → zod default. |
| `user_prefs` | Per-user agent overrides + notification toggles. JSON blobs (`agent_overrides_json`, `notifications_json`). |
| `user_notifications_seen` | Per-user pointer into `audit_log.id` for unread badge math. |
| `setup_tokens` | Single-row bootstrap token. Burned on first admin sign-in (`used_at` stamped); subsequent `/setup?token=X` returns 403. |

## Repo layout — where things live

```
app/                   Next.js App Router pages + API routes
  (sidebar)/           Pages with the persistent sidebar (dashboard, profile, admin/*, team)
  api/                 All server endpoints
    tasks/[id]/        Task-scoped: runs, approve, approve-implementation,
                       check-review, qa-fix/{start,comments}, diff, preview,
                       preview-shell
    runs/[id]/         Run-scoped: stream (SSE), message (chat resume), stop
    jira/              search + issue/[key] (Jira lookups for the new-task dialog)
    setup/             save + test/[id] (wizard endpoints — no auth gate)
    admin/             settings/save, settings/test/[id], kill-run
    profile/           save (per-user prefs)
    notifications/     unread-count, mark-read
    auth/              [...nextauth] (Auth.js handler)
    health/            liveness probe
  cards/[id]/          Card detail page (RunLog + ArtifactPanel + ChatBox + buttons)
  setup/step/[n]/      6-step wizard pages
  sign-in/             Google OAuth entry
  layout.tsx           Root layout, theme, HeroUI provider
  globals.css          Tailwind base + tokens

components/            React components (HeroUI-based)
  board/               Board.tsx, NewTaskDialog.tsx (the swimlane UI)
  card-detail/         Run log, artifact viewers, chat, all the "do something"
                       buttons (Approve, ApproveImplementation, Implement,
                       AmendPlan, FixFromQa, Archive, NewRun, Preview, DevShell)
  setup/               Wizard step components
  admin/               Settings UI, ops console
  profile/             Identity, agent defaults, notifications
  nav/                 Sidebar, header
  dashboard/           Activity feed, cost meter, throughput tiles
  loading/, theme/, toast/, ui/, brand/

server/                All server-only modules ('server-only' import where possible)
  agents/              registry.ts (the source of truth for agents),
                       sync.ts (boot-time DB cache rebuild),
                       pricing.ts (Claude API $/token tables for cost meter)
  auth/                config.ts (Auth.js callbacks + role assignment),
                       edge.ts (edge-safe middleware helper),
                       audit.ts, setupToken.ts
  cron/                nightly.ts (worktree pruning, run retention)
  db/                  client.ts (better-sqlite3 + Drizzle init),
                       schema.ts, migrate.ts, migrate-cli.ts,
                       migrations/*.sql
  git/                 worktree.ts (provision/teardown),
                       approve.ts (cycle-1: commit/push/PR/Jira),
                       approveCycle.ts (cycle-N>1: reuse PR),
                       implementComplete.ts (post-ce:work finalization),
                       implementComplete.ts Step 1c rewrites the PR description,
                       push.ts (robustPush with rebase fallback),
                       reviewVerdict.ts (parses READY/AMEND/REWRITE),
                       remoteCleanup.ts
  jira/                client.ts (REST API wrapper),
                       adf.ts (ADF primitives + implementCommentDoc),
                       shipNote.ts (parser + renderer for the ship-note),
                       qaFixComment.ts (cycle-N>1 comment),
                       amendComment.ts (when a Plan re-runs after AMEND)
  lib/                 config.ts (the settings resolver),
                       env.ts (Proxy that wraps configSchema),
                       settingsSchema.ts (declarative wizard schema),
                       settingsWrite.ts, settingsDrift.ts,
                       settingsTestActions.ts (the 'Test' buttons),
                       taskCycle.ts (cycle helpers — DERIVED from audit log),
                       userPrefs.ts, notifications.ts,
                       dashboardQueries.ts, enrichTask.ts,
                       errors.ts (AppError / NotFound / BadRequest / Conflict),
                       rateLimit.ts, route.ts (route handler helpers)
  worker/              startRun.ts (the spawn coordinator; called by 3 routes),
                       spawnAgent.ts (the actual `child_process.spawn`),
                       streamParser.ts (parses Claude stream-json),
                       persistArtifacts.ts (scrapes worktree → artifacts table),
                       autoAdvance.ts (lane → next lane on completion),
                       reconcile.ts (crash recovery — sweeps stale 'running' runs),
                       runRegistry.ts (in-process child handles for kill/stop),
                       runBus.ts (per-run EventEmitter for SSE),
                       costMeter.ts (cumulative $ + cap enforcement),
                       exitStatus.ts, chatMutex.ts,
                       resumeRun.ts (chat-resume path),
                       lazy-init.ts (DB boot hook)

tests/                 Vitest unit tests for parsers + helpers (no integration)
  shipNote.test.ts taskCycle.test.ts streamParser.test.ts
  decideExitStatus.test.ts dashboardQueries.test.ts settingsDrift.test.ts
  notifications.test.ts userPrefs.test.ts robustPush.test.ts config.test.ts

scripts/               install.sh (3-mode installer), uninstall.sh,
                       smoke-install.sh (fresh-DB boot smoke), dev-fresh.sh

docs/
  brainstorms/         Pre-plan exploration docs (per feature)
  plans/               Implementation plans (per feature) — load-bearing for
                       the pipeline; ce:plan writes here for each ticket
  reviews/             Review artifacts written by ce:review per ticket
  design/              heroui-conventions.md
  github-workflows/    claude-code-review.yml (copy-into-target-repo workflow)
  install-checklist.md, deploy.md
  (No /research/, /implementation/, /deploy/ here — those land in the
   target worktree, not in this repo.)

data/                  SQLite file (gitignored). app.db + WAL/SHM siblings.
public/                Static assets.
.next/                 Build output.
```

### Path aliases

`@/...` resolves to repo root (configured in `tsconfig.json`). Use it
in all imports — never relative `../../../`.

## Pages

| Path | Audience | What it shows |
|---|---|---|
| `/` | Everyone | "My Tasks" swimlane (cards owned by the signed-in user) |
| `/team` | Everyone | All tasks across the team with avatars |
| `/cards/[id]` | Owner + admin | Card detail: tabs for Run log, Artifacts, Changes, Description, Chat. All the action buttons live here. |
| `/dashboard` | Everyone | Ops health, cumulative cost meter, throughput, activity feed |
| `/profile` | Self | Identity + per-user agent defaults + notification toggles |
| `/admin/settings` | Admin only | Full settings UI mirroring the wizard |
| `/admin/ops` | Admin only | Active runs, kill-run, recent failures |
| `/setup` and `/setup/step/[n]` | Bootstrap only | First-run wizard, gated by `setup_tokens` row |
| `/sign-in` | Unauth | Google OAuth entry |

Sidebar is rendered by the `(sidebar)` route group (Next.js group
folder). Pages outside that group (`/`, `/team`, `/cards/:id`,
`/setup/*`, `/sign-in`) render without sidebar.

## API surface — the routes that matter

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness probe, no auth, no DB. |
| `/api/auth/[...nextauth]` | * | Auth.js handler. |
| `/api/setup/save` | POST | Wizard step write (token-gated, no session). |
| `/api/setup/test/[id]` | POST | Wizard "Test" buttons (jira, path, oauth-shape, cli, github-api, github-workflow). |
| `/api/admin/settings/save` | POST | Same shape as setup/save but admin-gated (post-bootstrap). |
| `/api/admin/settings/test/[id]` | POST | Admin re-test of a section. |
| `/api/admin/kill-run` | POST | Force-kill a run (SIGTERM → SIGKILL). |
| `/api/jira/search` | GET | JQL-ish search (used by the New Task dialog). |
| `/api/jira/issue/[key]` | GET | Single-issue fetch (title, description, comments). |
| `/api/tasks` | GET / POST | List + create. POST takes `{ jiraKey }`, dedupes against active tasks. |
| `/api/tasks/[id]` | GET / PATCH / DELETE | Read, edit description, archive. |
| `/api/tasks/[id]/runs` | POST | Start a run on this task in a given lane with a chosen agent. |
| `/api/tasks/[id]/approve` | POST | Cycle-1 Approve & PR (calls `approveAndPr`). For cycle N>1, `approveCycle`. |
| `/api/tasks/[id]/approve-implementation` | POST | Calls `implementComplete` — commits + pushes the agent's work, rewrites PR body, posts Jira, transitions, lane → done. |
| `/api/tasks/[id]/check-review` | POST | Re-parse the latest review verdict. |
| `/api/tasks/[id]/qa-fix/comments` | GET | List Jira comments since "done" for the picker modal. |
| `/api/tasks/[id]/qa-fix/start` | POST | Spawn a cycle-N>1 brainstorm with operator-selected QA findings. |
| `/api/tasks/[id]/diff` | GET | `git diff origin/main...HEAD` of the task's worktree. |
| `/api/tasks/[id]/preview` | POST | Swap the dev checkout (PREVIEW_DEV_PATH) to this task's branch. |
| `/api/tasks/[id]/preview-shell` | POST | (Optional, single-operator) shell exec in the worktree. Behind `PREVIEW_DEV_ENABLE_SHELL`. |
| `/api/runs/[id]/stream` | GET | SSE — replays from `Last-Event-ID` then live-tails new `messages` rows. |
| `/api/runs/[id]/message` | POST | Inject chat into the running Claude session (`--resume <sessionId>`). |
| `/api/runs/[id]/stop` | POST | Stop a run (SIGTERM, marks `status='stopped'`). |
| `/api/profile/save` | POST | Per-user prefs. |
| `/api/notifications/unread-count` | GET | Sidebar badge data. |
| `/api/notifications/mark-read` | POST | Bumps `last_seen_audit_id`. |

Everything except `/api/auth/*`, `/api/setup/*`, and `/api/health`
runs through `middleware.ts` for auth gating. Pages get a redirect to
`/sign-in?from=…`; API calls get a 401 JSON.

## Settings & config — the resolver

**Read every config value via `getConfig(key)`** from
`server/lib/config.ts`. Never touch `process.env` directly outside
that module. Precedence: settings row → `process.env` → zod default.
Cached 30s; `setConfig(key, value)` invalidates.

The schema is `configSchema` in the same file. The wizard renders
from the declarative `SETTINGS` array in
`server/lib/settingsSchema.ts` — adding a new configurable field
means: add a zod entry → add a `SettingField` row → done. Wizard
auto-renders, `/admin/settings` auto-renders, drift detection
auto-applies.

**Bootstrap env (read before DB exists):**
- `AUTH_SECRET` (or generated on first save)
- `DATABASE_URL` (defaults `./data/app.db`)

**Everything else is wizard-managed:** Google OAuth, Jira creds,
`BASE_REPO`, `WORKTREE_ROOT`, `ALLOWED_EMAIL_DOMAINS`,
`JIRA_START_STATUS`, `JIRA_REVIEW_STATUS`, preview paths,
`AGENT_OVERRIDES`.

`server/auth/config.ts` rejects sign-ins when `ALLOWED_EMAIL_DOMAINS`
is empty — fresh installs deny everyone until the wizard fills it.

## Conventions

- **TypeScript strict.** No `any` without a `// eslint-disable` and a
  reason. Drizzle's inferred types are good — use them
  (`typeof tasks.$inferSelect`).
- **`server-only`** import on any module that touches the DB or
  secrets. Exception: modules transitively loaded by the migrate CLI
  (which is Node, not Next.js). See header comments in
  `server/lib/config.ts`, `server/auth/audit.ts`, `server/db/migrate.ts`.
- **DB writes** go through Drizzle, never raw SQL strings except in
  migration files.
- **Always `audit({...})` after a side effect.** Audit row IS the dedup
  source of truth for "did we already do this?" checks.
- **Errors:** throw `AppError`, `NotFound`, `BadRequest`, `Conflict`
  from `server/lib/errors.ts`. Route helpers in
  `server/lib/route.ts` map them to HTTP statuses.
- **Spawned subprocesses** use **minimised env** — explicit allow-list
  (`PATH`, `HOME`, `LANG`, `USER`, `TERM`, optionally
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`). NEVER spread
  `process.env` into Claude's reach (would leak `SLACK_WEBHOOK`,
  `GH_TOKEN`, etc. via Bash tool calls). See
  `server/worker/spawnAgent.ts` and `server/git/approve.ts:ghEnv()`.
- **UI:** HeroUI v3 components first, Tailwind tokens for layout.
  Conventions in `docs/design/heroui-conventions.md`.
- **Tests:** vitest, mostly pure-function unit tests in `tests/`.
  Integration tests via the `npm run smoke:install` script.

## Cycle helpers — read these before touching multi-pass logic

`server/lib/taskCycle.ts` exposes the audit-derived cycle helpers.
The four most-called:

- `currentCycleNumber(taskId)` — 0 (no brainstorm yet) → 1 → 2 → …
- `getCycleContext(taskId)` — `{ count, number, startedAt }` in one
  query.
- `qaFixCycleCount(taskId)` — count of QA-fix-flagged cycles.
- `wasQaFixCycleRun(runId)` / `isTaskInQaFixCycle(taskId)` —
  predicates for QA-fix gating.

The cycle boundary is the start of a non-superseded **brainstorm**
run. When the workflow becomes customizable per the
`docs/brainstorms/2026-04-23-customizable-workflows-brainstorm.md`
work, swap `CYCLE_START_LANES` for a `lanes.role='cycle_start'`
query. Until then, the constant is the single point of compatibility.

## Worker internals — the agent loop

The hot path when an operator clicks "Run brainstorm":

1. `POST /api/tasks/[id]/runs` — auth, validation, calls
   `startRun()` in `server/worker/startRun.ts`.
2. `startRun` validates the lane, ensures the worktree
   (`server/git/worktree.ts:ensureWorktree`), reads prior artifacts +
   recent commits + Jira comments, builds `PromptContext`, picks the
   prompt builder (`agent.buildPrompt`, `buildAmendPlanPrompt`, or
   `buildQaFixBrainstormPrompt`), inserts the `runs` row, marks any
   prior live run for this lane `superseded`, calls `spawnAgent()`.
3. `spawnAgent` (`server/worker/spawnAgent.ts`) forks
   `stdbuf -oL -eL claude -p <prompt> --output-format stream-json
   --verbose --permission-mode <mode> --model <model>`.
4. stream-json output is line-parsed by `streamParser.ts`, each event
   becomes a `messages` row + emits on the run's EventEmitter
   (`runBus.ts`). SSE clients on `/api/runs/[id]/stream` see them
   live.
5. Cost meter (`costMeter.ts`) accumulates tokens × pricing
   (`agents/pricing.ts`); at warn cap → warn event; at kill cap →
   SIGTERM → SIGKILL.
6. On exit, `decideExitStatus()` maps subprocess outcome to a `runs`
   status. `persistArtifacts.ts` scrapes the worktree for the
   expected `docs/<lane>s/<key>-<kind>.md` file (or the agent's
   `produces` override) and writes the `artifacts` row. **Stalemarks
   downstream artifacts** if this is a re-run.
7. `autoAdvance.ts` decides whether to spawn the next lane's agent
   (brainstorm → plan → review). It does NOT auto-advance into PR or
   implement — those are operator-gated.
8. **Crash recovery:** `reconcile.ts` runs at boot via
   `server/worker/lazy-init.ts`. Sweeps `runs` with status='running'
   but no live process; if PID is gone, marks `interrupted`.

**Chat resume:** `POST /api/runs/[id]/message` calls
`startRun({ resumeSessionId, overridePrompt: <user message>, … })`.
Same pipeline; Claude `--resume <sessionId>` carries the prior
context.

## QA-fix loop — the cycle N>1 trigger

After a card lands at `done` and a human QA review surfaces issues
in Jira comments, the operator clicks **Fix from QA** on the card:

1. `QaCommentPickerModal` shows Jira comments since the most recent
   `task.implementation_complete` audit row.
2. Operator selects the comments that constitute QA findings.
3. `POST /api/tasks/[id]/qa-fix/start` calls `startRun({ qaFixCycle:
   true, qaCommentIds: […], lane: 'brainstorm' })`.
4. `buildQaFixBrainstormPrompt` wraps the standard brainstorm prompt
   with a `## QA findings — round N` prelude built from the selected
   comments.
5. Cascade resumes (brainstorm → plan → review → operator approves
   → implement → operator approves implementation → done) — exactly
   like cycle 1 but the second time around.
6. Cycle-N approves use `approveCycle()` (no new PR; same branch),
   and `implementComplete` posts the cycle-N>1 Jira comment via
   `postQaFixComment` which delegates to the same
   `buildImplementationShipNote(..., cycleNumber: N)` renderer.

See `docs/plans/2026-05-01-feat-qa-failed-fix-loop-plan.md` for the
full spec and `docs/plans/2026-05-01-fix-card-detail-bug-cluster-plan.md`
for the bug cluster fixes that shipped alongside it.

## Implementation handoff (active feature, branch `feat/implementation-handoff-improvements`)

Goal: a QA tester reading the Jira "Implementation complete" comment
alone can identify what's new, what's risky, and which scenarios to
test — without opening the PR, the diff, or the implementation.md
artifact.

**Three layers, single PR:**

1. **`ce:work` prompt contract** — `workPrompt` in
   `server/agents/registry.ts` requires four h2 sections in
   `docs/implementation/<KEY>-implementation.md`: `## Summary`,
   `## User-visible changes`, `## Risk areas`, `## Test Plan`. Plus
   recognised optionals: `Files Touched`, `Out of scope`,
   `Migration notes`, `Rollback`.

2. **Shared parser + renderer** — `server/jira/shipNote.ts` exports
   `extractShipNoteSections(markdown)` and
   `buildImplementationShipNote(input)`. Returns
   `{ adf, markdown }` — byte-identical content. Strict allowlist on
   heading match; soft-fail with placeholder text when sections
   missing.

3. **`implementComplete` Step 1c — PR description rewrite** —
   `gh pr edit <branch> --body-file <tmp.md>` between the existing
   Step 1b (`gh pr ready`) and Step 2 (Jira comment). Best-effort:
   `gh pr edit` failure is warn-only and audited; the Jira comment
   still fires. Idempotent via `hasPriorAudit("pr.description_updated")`.

The legacy `implementCommentDoc` in `server/jira/adf.ts` now
delegates to `buildImplementationShipNote`. `postQaFixComment` does
the same with `cycleNumber: N` for cycle N>1.

Plan: `docs/plans/2026-05-05-feat-implementation-handoff-improvements-plan.md`
Brainstorm: `docs/brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md`
Tests: `tests/shipNote.test.ts` (≥12 cases — heading variations,
missing sections, optional ordering, cycle-N heading swap, empty
input).

## Where to look when…

| Question | File |
|---|---|
| Add a configurable setting | `server/lib/config.ts` (zod) + `server/lib/settingsSchema.ts` (UI row) |
| Tweak an agent's prompt | `server/agents/registry.ts` — `buildPrompt` of the relevant agent |
| Change the lane sequence | `tasks.currentLane` enum in `server/db/schema.ts` + `autoAdvance.ts` + `Lane` type in `server/agents/registry.ts` |
| Add a new artifact kind | `artifacts.kind` enum in schema + `persistArtifactsForRun` mapping |
| Change what gets committed on Approve & PR | `server/git/approve.ts` (cycle 1) + `approveCycle.ts` (cycle N>1) |
| Change the implementation handoff body | `server/jira/shipNote.ts` |
| Touch the Jira REST contract | `server/jira/client.ts` |
| Add a card-detail button | `components/card-detail/<X>Button.tsx` + an API route under `app/api/tasks/[id]/...` |
| Add an admin settings test action | `server/lib/settingsTestActions.ts` (`TestActionId` union + handler) |
| Inspect a stuck run | `/admin/ops` page or `sqlite3 data/app.db 'SELECT id,lane,status,startedAt FROM runs WHERE status="running"'` |
| Wipe state and re-bootstrap | `npm run dev:fresh` (deletes `data/app.db`, re-migrates, prints new setup token) |

## Things to NOT do

- **Don't add a global state store (Redux / Zustand etc.)** — server
  is the source of truth, components fetch on mount + listen to SSE.
- **Don't introduce a job queue** — the `child_process.spawn` model is
  intentional and matches the team-size assumption (<10 concurrent
  runs). BullMQ / a worker pool was considered and rejected in the
  brainstorm.
- **Don't `JSON.parse` settings values directly** — `getConfig()` does
  it through zod and caches the result.
- **Don't relax the ship-note heading allowlist** — the strict matcher
  is a feature; a forgiving parser would silently merge "## Tests"
  content into the wrong slot.
- **Don't mutate `process.env`** — config flow is one-way.
- **Don't commit from the agent.** `ce:work` is instructed to leave
  changes uncommitted; `implementComplete` does the single clean
  commit with the right author + ticket-referencing message.
- **Don't bypass the worktree boundary.** Agents are subprocesses
  rooted at the per-task worktree under `WORKTREE_ROOT`. Do not run
  agents in the orchestrator repo.
- **Don't skip auth on a new `/api/*` route.** `middleware.ts` is the
  default; only `/api/auth`, `/api/setup`, and `/api/health` are
  exempt, and that exemption is intentional.

## Pointers to original design docs

- **Brainstorms** — `docs/brainstorms/`. Core architecture in
  `2026-04-20-nextjs-agent-swimlanes-brainstorm.md`. Setup wizard,
  sidebar, customizable workflows, QA-fix loop, implementation
  handoff each have their own brainstorm.
- **Plans** — `docs/plans/`. The implementation playbooks. Phase
  breakdowns, acceptance criteria, risk tables. The
  implementation-handoff plan
  (`2026-05-05-feat-implementation-handoff-improvements-plan.md`) is
  the most recent and reflects the current feature on this branch.
- **Reviews** — `docs/reviews/`. Pre-implementation reviews of the
  bigger plans.
- **Install / deploy** — `README.md`, `docs/install-checklist.md`,
  `docs/deploy.md`.

## Glossary

- **Lane** — one stage of the pipeline (`brainstorm`, `plan`, …).
- **Run** — one Claude CLI invocation tied to a (task, lane) pair.
- **Artifact** — markdown file emitted by an agent run, persisted as
  a `artifacts` row + (on approval) committed under `docs/<lane>s/`.
- **Cycle** — one full pass `brainstorm → … → done`. Cycle N>1 = a
  re-pass after the card already reached done.
- **Ship-note** — the structured `implementation.md` body that gets
  rendered into both the Jira comment and the GitHub PR description
  on Approve Implementation. Four required sections.
- **Worktree** — per-task git worktree under `WORKTREE_ROOT`. Branch
  `<JIRAKEY>-ai`. Created on Branch lane entry, pruned by the
  nightly cron + `Archive`.
- **Approve & PR** — operator-clicked gate at review → pr. Commits
  artifacts, opens draft PR.
- **Approve Implementation** — operator-clicked gate at implement →
  done. Commits the agent's code, rewrites PR body, posts richer
  Jira comment, transitions ticket.
- **CE pipeline** — Compound Engineering: `ce:brainstorm` →
  `ce:plan` → `ce:review` → `ce:work`. Provided as Claude Code
  skills.
