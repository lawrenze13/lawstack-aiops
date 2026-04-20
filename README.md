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
cp .env.example .env            # then fill in real secrets
npm run db:migrate              # creates ./data/app.db
npm run dev                     # http://localhost:3300 (pinned to avoid clash with ui.multiportal.io on 3000)
```

> ⚠ If you see `NODE_MODULE_VERSION 115 ... requires NODE_MODULE_VERSION 108`, you're running the wrong Node version. Run `nvm use` (or `nvm use 20`) before `npm run dev`. The native better-sqlite3 binding is compiled against the Node version that ran `npm install`.

## Environment variables

See `.env.example`. Phase 1 requires:

- `AUTH_SECRET` (`openssl rand -hex 32`)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` (Google Cloud OAuth client)
- `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`
- `ALLOWED_EMAIL_DOMAIN` (defaults to `multiportal.io`)

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
