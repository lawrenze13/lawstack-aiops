# LawStack/aiops

Operator console for Claude Code — ticket → PR, in lanes. Drives the
Compound Engineering pipeline (brainstorm → plan → review → implement)
against Jira tickets, one agent per lane, artifacts stored in DB,
served behind Caddy.

## Install on a fresh Ubuntu / Debian VPS

One command — installs Caddy, Node 20, the Claude CLI, and this app as
a systemd service behind Caddy TLS:

```bash
curl -fsSL https://raw.githubusercontent.com/lawrenze13/lawstack-aiops/main/scripts/install.sh \
  | sudo bash -s -- \
    --domain aiops.yourdomain.tld \
    --user $(whoami)
```

**What you need first:**

- A DNS `A` record for `aiops.yourdomain.tld` → your VPS's public IP
  (`dig aiops.yourdomain.tld +short` should match `curl https://api.ipify.org`)
- Ports 80 + 443 open inbound (Let's Encrypt needs 80 for HTTP-01)
- A unix user with `sudo` (create one: `sudo useradd -m -s /bin/bash deploy`)
- A Google OAuth Web Application Client with redirect URI set to
  `https://aiops.yourdomain.tld/api/auth/callback/google`
  (the installer prints this reminder at the end)

**After install completes:**

1. Tail the journal to grab the one-time setup URL:
   `sudo journalctl -u aiops-aiops -n 30 | grep -A2 "SETUP REQUIRED"`
2. Open that URL in a browser — walk the 6 wizard steps (Google OAuth
   credentials, Jira, paths, agents)
3. Sign in with Google; the first signed-in user auto-promotes to admin

See [`docs/install-checklist.md`](docs/install-checklist.md) for the
full step-by-step and troubleshooting.

### Uninstall

```bash
sudo bash /var/www/aiops.yourdomain.tld/scripts/uninstall.sh \
  --domain aiops.yourdomain.tld
```

Add `--purge-data --purge-env` for scorched-earth removal.

## Stack

- Next.js 15 (App Router, Node runtime) + TypeScript strict
- Auth.js v5 + Google (domain-restricted — configured via wizard)
- better-sqlite3 + Drizzle ORM (WAL mode)
- HeroUI v3 + Tailwind v4 + dnd-kit
- `child_process.spawn('claude', ...)` for agent execution
- SSE for live streaming
- systemd + Caddy for production

## Quick start (development)

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

## Pages

- **`/`** — My Tasks swimlane board (ticket → branch → … → done)
- **`/team`** — Team board (everyone's tasks)
- **`/dashboard`** — Ops health, cost meter, throughput, activity feed
- **`/profile`** — Your identity, per-user agent defaults, notifications
- **`/admin/settings`** — Instance-wide config (admin-only)
- **`/admin/ops`** — Ops console (admin-only)

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
