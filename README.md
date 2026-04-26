# LawStack/aiops

Operator console for Claude Code — ticket → PR, in lanes. Drives the
Compound Engineering pipeline (brainstorm → plan → review → implement)
against Jira tickets, one agent per lane, artifacts stored in DB,
served behind Caddy.

## Install

The installer supports three modes depending on how production-ready
you want the deploy to be. All three use the same `scripts/install.sh`
with a `--mode` flag.

### Mode comparison

| Mode | What it sets up | Needs sudo? | TLS? | Best for |
|---|---|---|---|---|
| **`local`** | App only — background process on `localhost:PORT`, no systemd, no Caddy, no TLS | No (if PORT > 1024) | None | Try it on your laptop, home server, LAN |
| **`proxy`** | App + systemd service | Yes | You handle it | You already run nginx, Cloudflare Tunnel, Traefik, etc. |
| **`full`** | App + systemd + Caddy + Let's Encrypt | Yes | Automatic | Fresh public VPS |

> **Note:** the `curl … | bash` snippets below pin to `v0.1.0` (a git
> tag) rather than `main`. GitHub's raw-content CDN caches `main`
> aggressively — pinning to a tag avoids "I pushed a fix but the next
> install still got the old script" gotchas. Bump the tag in the URL
> when you want a newer release.

### Local mode — no domain, no Caddy, no sudo

Good for trying it on a laptop or single-user home server. Runs on
`http://localhost:3300` with a pidfile; zero external surface.

```bash
curl -fsSL https://raw.githubusercontent.com/lawrenze13/lawstack-aiops/v0.1.0/scripts/install.sh \
  | bash -s -- --mode local
```

What happens:
- Clones repo to `~/.local/share/lawstack-aiops`
- Installs Node 20 via nvm (user-scoped)
- Installs `@anthropic-ai/claude-code` globally for this user
- Builds + runs `npm start` via `nohup` with pidfile at
  `~/.local/share/lawstack-aiops/aiops.pid`
- Opens `http://localhost:3300` in a browser to start the setup wizard

```bash
# Day-to-day (local mode):
tail -f ~/.local/share/lawstack-aiops/aiops.log     # live logs
kill $(cat ~/.local/share/lawstack-aiops/aiops.pid) # stop
# Restart: re-run the install command — it's idempotent
```

### Proxy mode — systemd service, bring your own reverse proxy

You run nginx / Cloudflare Tunnel / Traefik / whatever. Installer sets
up a systemd service on `localhost:PORT`; you wire it up externally.

```bash
curl -fsSL https://raw.githubusercontent.com/lawrenze13/lawstack-aiops/v0.1.0/scripts/install.sh \
  | sudo bash -s -- \
    --mode proxy \
    --user deploy \
    --domain aiops.yourdomain.tld
```

`--domain` is used only for `AUTH_URL` (the cookie domain auth.js
signs against). The install doesn't touch Caddy or DNS. After install,
point your existing reverse proxy at `http://localhost:3300`.

### Full mode — systemd + Caddy + auto-TLS

One command, fresh public VPS → working HTTPS deploy:

```bash
curl -fsSL https://raw.githubusercontent.com/lawrenze13/lawstack-aiops/v0.1.0/scripts/install.sh \
  | sudo bash -s -- \
    --mode full \
    --domain aiops.yourdomain.tld \
    --user deploy
```

The installer auto-installs Caddy 2.x (apt-based) if missing, appends
a reverse-proxy block to `/etc/caddy/Caddyfile` idempotently, and
Caddy provisions a Let's Encrypt cert on first request.

**Prereqs for full mode:**

- DNS `A` record for `aiops.yourdomain.tld` → your VPS public IP
- Ports 80 + 443 open inbound (LE HTTP-01 challenge + HTTPS)
- A sudo-capable unix user that isn't root (create one:
  `sudo useradd -m -s /bin/bash deploy && sudo usermod -aG sudo deploy`)
- Google OAuth Web Application Client with redirect URI
  `https://aiops.yourdomain.tld/api/auth/callback/google`

### After any mode completes

1. Grab the one-time setup URL:
   - **Full/proxy**: `sudo journalctl -u <slug>-aiops -n 30 | grep -A2 "SETUP REQUIRED"`
   - **Local**: `grep -A2 "SETUP REQUIRED" ~/.local/share/lawstack-aiops/aiops.log`
2. Open that URL in a browser; walk the 6-step setup wizard
3. Sign in with Google; first signed-in user auto-promotes to admin

See [`docs/install-checklist.md`](docs/install-checklist.md) for full
step-by-step + troubleshooting.

### All installer flags

```
--mode            local | proxy | full         (default: full)
--domain DOMAIN   required for full mode; optional in proxy mode
--user USER       required for full and proxy modes
--port PORT       default 3300
--install-dir DIR default depends on mode
--branch BRANCH   default main
--repo URL        default this repo's HTTPS url
--worktree-root D default /var/aiops/worktrees
--dry-run         print actions without executing
```

### Uninstall

```bash
# full / proxy mode:
sudo bash <install-dir>/scripts/uninstall.sh --domain aiops.yourdomain.tld

# local mode:
kill $(cat ~/.local/share/lawstack-aiops/aiops.pid) 2>/dev/null
rm -rf ~/.local/share/lawstack-aiops
```

Add `--purge-data --purge-env` to scorched-earth the DB + worktrees + secrets.

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
- **`/profile`** — Your identity, per-user agent defaults, notifications,
  **and per-user Connections** (Jira creds, GitHub PAT, git author identity —
  see [`docs/runbooks/per-user-tokens.md`](docs/runbooks/per-user-tokens.md))
- **`/admin/settings`** — Instance-wide config (admin-only)
- **`/admin/ops`** — Ops console (admin-only) — includes "Instance fallback (7d)"
  metric for tracking who's relying on the box's god-token
- **`/admin/users`** — Admin-only user-credential overview with per-service
  "configured / instance default" chips and clear-on-behalf actions

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
  AND used as the IKM for at-rest token encryption (see below).
- `DATABASE_URL` (default `./data/app.db`)
- `TOKEN_ENCRYPTION_KEY` (optional, `openssl rand -base64 32`) —
  separate 32-byte key for at-rest credential encryption. If unset,
  the key is HKDF-derived from `AUTH_SECRET`. Set this explicitly if
  you ever want to rotate `AUTH_SECRET` without invalidating every
  encrypted blob. See [`docs/SECURITY.md`](docs/SECURITY.md).

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
