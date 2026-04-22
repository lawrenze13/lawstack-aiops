#!/usr/bin/env bash
#
# One-shot: nuke any existing sandbox DB, migrate a fresh SQLite, and
# start `next dev` against it on a sandbox port. Leaves your real
# ./data/app.db untouched.
#
# Usage:
#   bash scripts/dev-fresh.sh              # default port 3400, /tmp DB
#   PORT=4000 bash scripts/dev-fresh.sh    # custom port
#   DB_PATH=./data/wizard.db bash scripts/dev-fresh.sh   # custom DB
#
# Stop the server with Ctrl-C. The DB persists between runs so you can
# rerun the wizard from step N; delete the file to really start over.
#
set -euo pipefail

PORT="${PORT:-3400}"
DB_PATH="${DB_PATH:-/tmp/aiops-fresh.db}"
HOST="${HOST:-localhost}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

say() { printf '\033[1;36m[fresh]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fresh]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fresh] FAIL:\033[0m %s\n' "$*"; exit 1; }

# ── Node 20+ required
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo "")
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 20 ]]; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    say "Loading nvm and switching to Node 20"
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || nvm install 20
  fi
  NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
  [[ "$NODE_MAJOR" -ge 20 ]] || fail "Node ≥20 required (got $(node --version))"
fi
say "Node $(node --version)"

# ── Port check
if command -v lsof >/dev/null && lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  warn "Port $PORT is already in use. Pick another with PORT=xxxx or kill the holder."
  lsof -iTCP:"$PORT" -sTCP:LISTEN | head -3
  exit 1
fi

# ── Deps
if [[ ! -d node_modules ]]; then
  say "Installing npm deps (first run)"
  npm install
fi

# ── Fresh DB
if [[ -f "$DB_PATH" ]]; then
  warn "Removing existing sandbox DB at $DB_PATH"
  rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal"
fi
mkdir -p "$(dirname "$DB_PATH")"

say "Migrating fresh SQLite at $DB_PATH"
DATABASE_URL="$DB_PATH" npm run db:migrate --silent

# ── Bootstrap secret (per-run; persisted in env for this process tree)
AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -hex 32)}"
AUTH_URL="http://${HOST}:${PORT}"

cat <<EOF

╭────────────────────────────────────────────────────────────╮
│  Fresh AIOPS sandbox                                       │
│                                                            │
│    DB        $DB_PATH
│    URL       $AUTH_URL
│    Your prod DB at ./data/app.db is untouched.             │
│                                                            │
│  The server will print a SETUP REQUIRED banner with a      │
│  one-time /setup?token=… URL below once you hit any route. │
│  Open that URL to walk the wizard.                         │
╰────────────────────────────────────────────────────────────╯

EOF

# ── Boot
# Scrub inherited wizard-owned env vars so a fresh DB really IS fresh —
# your repo's .env has production Google/Jira creds, which would make
# /sign-in render the Google button (oauthConfigured=true) and skip the
# wizard. Empty strings override .env (Next.js loads .env first, then
# process.env wins) and zod's optionalStr coerces "" back to undefined.
export DATABASE_URL="$DB_PATH"
export AUTH_SECRET
export AUTH_URL
export PORT
export AUTH_GOOGLE_ID=""
export AUTH_GOOGLE_SECRET=""
export JIRA_BASE_URL=""
export JIRA_EMAIL=""
export JIRA_API_TOKEN=""
export BASE_REPO=""
exec npx next dev -p "$PORT"
