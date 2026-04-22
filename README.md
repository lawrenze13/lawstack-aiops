# multiportal-ai-ops

Next.js 15 swimlane UI for driving Claude Code agents on Jira tickets. Replaces the existing Slack + n8n + `ticket-worker.sh` flow on this VPS.

See [`docs/plans/2026-04-20-feat-nextjs-agent-swimlanes-orchestration-plan.md`](docs/plans/2026-04-20-feat-nextjs-agent-swimlanes-orchestration-plan.md) for the canonical architecture and roadmap.

## Stack

- Next.js 15 (App Router, Node runtime) + TypeScript strict
- Auth.js v5 + Google (restricted to `@multiportal.io`)
- better-sqlite3 + Drizzle ORM (WAL mode)
- shadcn/ui + Tailwind v4 + dnd-kit
- `child_process.spawn('claude', ...)` for agent execution (post Phase 1)
- SSE for live streaming (post Phase 1)

## Status

Phase 1 (Foundation) — in progress. Phases 2–4 deliver the agent runner, Approve & PR pipeline, and Slack cutover.

## Quick start

```bash
nvm use                         # picks Node 20 from .nvmrc
npm install
npm run db:migrate              # creates ./data/app.db
npm run dev                     # http://localhost:3300 (pinned to avoid clash with ui.multiportal.io on 3000)
```

Watch stdout for a `SETUP REQUIRED` banner with a tokenised URL — open
it in a browser to walk the first-run wizard. The wizard writes every
knob (Google OAuth, Jira, paths, agents, preview, CI) into the
`settings` table; no `.env` required for app config.

> ⚠ If you see `NODE_MODULE_VERSION 115 ... requires NODE_MODULE_VERSION 108`, you're running the wrong Node version. Run `nvm use` (or `nvm use 20`) before `npm run dev`. The native better-sqlite3 binding is compiled against the Node version that ran `npm install`.

## Setup

See **[`docs/install-checklist.md`](docs/install-checklist.md)** for the
full first-run walkthrough including the Google OAuth client and each
wizard step.

Quick checks:

```bash
bash scripts/smoke-install.sh   # fresh-DB boot + token + save path
curl -s localhost:3300/api/health   # liveness probe, no auth
```

## Environment variables

All runtime knobs live in the `settings` table (managed via the
setup wizard or `/admin/settings`). `process.env` is still honoured
as a fallback for operators who prefer env vars — precedence is
`settings row → process.env → zod default`.

Minimum bootstrap env (set these before first boot if you want them to
seed into the wizard as defaults):

- `AUTH_SECRET` (`openssl rand -hex 32`) — required for JWT signing
- `DATABASE_URL` (default `./data/app.db`)

Everything else is configurable through the UI without a restart.

## Repo layout

```
app/             Next.js App Router pages + API routes
components/      shadcn UI (owned) + feature components
server/          DB, auth, Jira, worker (post Phase 1) modules
data/            SQLite file (gitignored)
docs/            Brainstorms, plans, runbooks
```

## License

Internal — multiportal.io team only.
