---
title: Deployment (systemd + Caddy)
date: 2026-04-21
---

# Deploying multiportal-ai-ops to aiops.multiportal.io

Target: same VPS as `ui.multiportal.io` / `lawrenze.multiportal.io`. Single-process Next.js
15 on port **3300** behind Caddy on :443. No Redis, no worker processes, no containers.

## 0. One-time host prep (as root or sudo)

```bash
sudo mkdir -p /var/aiops/worktrees
sudo chown -R lawrenzem:lawrenzem /var/aiops
```

## 1. Build + install the app

```bash
cd /var/www/aiops.multiportal.io
nvm use                       # Node 20 from .nvmrc
npm ci                        # clean install matching package-lock
cp .env.example .env          # then fill real secrets (see below)
npm run db:migrate            # applies drizzle migrations
npm run build
```

### Required `.env`

```
AUTH_SECRET=<openssl rand -hex 32>
AUTH_GOOGLE_ID=<google oauth client id>
AUTH_GOOGLE_SECRET=<google oauth client secret>
AUTH_URL=https://aiops.multiportal.io

ALLOWED_EMAIL_DOMAINS=multiportal.io,hostednetwork.com.au

JIRA_BASE_URL=https://<workspace>.atlassian.net
JIRA_EMAIL=<owner email for API token>
JIRA_API_TOKEN=<atlassian api token>
JIRA_START_STATUS=In Progress

GH_TOKEN=<fine-grained PAT: Contents rw + Pull requests rw on target repo>

WORKTREE_ROOT=/var/aiops/worktrees
BASE_REPO=/var/www/lawrenze.multiportal.io
```

Optionally, for the spawned `claude` subprocess (falls back to logged-in session if unset):

```
# ANTHROPIC_API_KEY=
# CLAUDE_CODE_OAUTH_TOKEN=
```

## 2. systemd service

Create `/etc/systemd/system/multiportal-ai-ops.service`:

```ini
[Unit]
Description=multiportal-ai-ops (Next.js)
After=network.target
# Reap Claude child processes when we stop so they don't become
# orphans writing to closed pipes.

[Service]
Type=simple
User=lawrenzem
Group=lawrenzem
WorkingDirectory=/var/www/aiops.multiportal.io
Environment=NODE_ENV=production
Environment=PATH=/home/lawrenzem/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/var/www/aiops.multiportal.io/.env

# Run migrations before the server starts so a fresh deploy can't
# race route handlers against a missing schema.
ExecStartPre=/home/lawrenzem/.nvm/versions/node/v20.20.2/bin/npm run db:migrate
ExecStart=/home/lawrenzem/.nvm/versions/node/v20.20.2/bin/npm run start

# KillMode=mixed sends SIGTERM to the main process AND to the cgroup —
# our spawned claude children die with their parent instead of lingering
# as orphans (which is what triggered the interrupted-run flakiness
# during dev; see commit 80f69a5).
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=15

# Restart on crash, but not if we hit a non-zero exit < 2s (usually
# a config error — don't mask it with a loop).
Restart=on-failure
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=5

# Hardening (optional — enable incrementally if nothing breaks).
# ProtectSystem=full
# ProtectHome=read-only
# PrivateTmp=yes
# NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now multiportal-ai-ops.service
sudo systemctl status multiportal-ai-ops.service
```

Tail logs:

```bash
journalctl -fu multiportal-ai-ops.service
```

## 3. Caddy reverse proxy

Append to `/etc/caddy/Caddyfile`:

```caddy
aiops.multiportal.io {
    encode zstd gzip

    # SSE endpoints MUST disable response buffering — `flush_interval -1`
    # tells Caddy to flush each chunk as soon as it arrives from Node.
    # Without this, the browser sees events arrive in big bursts instead
    # of streaming live.
    handle /api/runs/*/stream {
        reverse_proxy localhost:3300 {
            flush_interval -1
            transport http {
                read_timeout 0
                write_timeout 0
            }
        }
    }

    reverse_proxy localhost:3300

    log {
        output file /var/log/caddy/aiops.multiportal.io.log
    }
}
```

Reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Google OAuth — redirect URI

In Google Cloud Console → Credentials → your OAuth client →
**Authorized redirect URIs**, add:

```
https://aiops.multiportal.io/api/auth/callback/google
```

(Keep `http://localhost:3300/api/auth/callback/google` for dev.)

## 4. Nightly maintenance (systemd timer)

Create `/etc/systemd/system/multiportal-ai-ops-nightly.service`:

```ini
[Unit]
Description=multiportal-ai-ops nightly cron
After=multiportal-ai-ops.service

[Service]
Type=oneshot
User=lawrenzem
Group=lawrenzem
WorkingDirectory=/var/www/aiops.multiportal.io
EnvironmentFile=/var/www/aiops.multiportal.io/.env
ExecStart=/home/lawrenzem/.nvm/versions/node/v20.20.2/bin/npm run cron:nightly
```

And `/etc/systemd/system/multiportal-ai-ops-nightly.timer`:

```ini
[Unit]
Description=Run multiportal-ai-ops nightly cron daily at 03:15

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now multiportal-ai-ops-nightly.timer
systemctl list-timers multiportal-ai-ops-nightly.timer
```

What the cron does (see `server/cron/nightly.ts`):

- Deletes `messages` rows older than 90 days (runs + audit_log retained)
- Removes on-disk worktrees for tasks archived > 24h ago
- Nullifies stale `last_heartbeat_at` on orphaned run rows so they
  don't show up as "stuck" in admin ops
- Runs `wal_checkpoint(TRUNCATE)` on Sundays to reclaim WAL space

## 5. Deploy flow on subsequent updates

```bash
cd /var/www/aiops.multiportal.io
git pull
nvm use
npm ci
npm run db:generate           # only if schema changed
npm run db:migrate
npm run build
sudo systemctl restart multiportal-ai-ops.service
```

systemd's `KillMode=mixed` ensures any live `claude` subprocesses get
SIGTERM along with the main Node process. New process's boot reconciler
(1-hour cutoff, see `server/worker/reconcile.ts`) leaves the just-
interrupted runs visible for an hour so operators can Resume them.

## 6. Operational checks

After deploy, verify:

- `systemctl is-active multiportal-ai-ops.service` → `active`
- `curl -sSfI https://aiops.multiportal.io/sign-in` → `200`
- `curl -sSf https://aiops.multiportal.io/api/tasks` → `{"error":"unauthorized"}` (gate working)
- `/admin/ops` page loads (sign in as an admin first)
- Kick off a throwaway run; watch SSE events arrive in the browser;
  confirm cost meter + turn counter update live
- `journalctl -fu multiportal-ai-ops.service` during the run should
  be quiet — Claude stdout/stderr is captured by the Node process, not logged

## 7. Rollback

```bash
sudo systemctl stop multiportal-ai-ops.service
cd /var/www/aiops.multiportal.io
git checkout <previous-sha>
npm ci
npm run build
sudo systemctl start multiportal-ai-ops.service
```

DB schema migrations are forward-only; if you rolled back past a
schema change, manually reverse with Drizzle Studio or a one-off SQL
patch. Worth keeping a pre-deploy `sqlite3 data/app.db .dump > backup.sql`.

## 8. Dark-launch plan (pre-cutover)

Before routing real Jira webhook traffic to this app, dual-run the
old Slack/n8n flow alongside it:

- **Week 1 (dark):** aiops receives Jira webhooks (via n8n forward) and
  writes rows to its DB but does NOT post to Jira, open PRs, or send
  notifications. You use both systems; compare outputs.
- **Cutover day:** disable n8n's outbound nodes (don't delete — rollback
  aid). Enable aiops outbound (remove any `if (DARK)` guards we add in
  Phase 4B). Monitor 48h.
- **Day 14:** archive `ticket-worker.sh`, `ticket-resume.sh`,
  `claude-stream-to-slack.sh` to `/home/lawrenzem/bin/_archive/`. Delete
  the n8n workflows.

The dark-launch guard is not in the code yet — Phase 4B will add a
`DARK_LAUNCH=true` env flag that short-circuits outbound calls
(`postComment`, `transitionIssueToName`, `gh pr create`).
