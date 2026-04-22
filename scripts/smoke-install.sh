#!/usr/bin/env bash
#
# Fresh-install smoke test. Verifies the setup wizard boots, prints a
# token, accepts field saves through /api/setup/save, and records rows
# in the settings table. This does NOT exercise the OAuth handshake or
# the /api/setup/test/:id actions — those require real third-party
# credentials and live elsewhere (see docs/install-checklist.md).
#
# Exits 0 on success, non-zero with a loud message on any failure.
# Safe to re-run: builds a disposable sandbox under /tmp and cleans up.
#
# Usage:
#   bash scripts/smoke-install.sh
#   SMOKE_PORT=4410 bash scripts/smoke-install.sh
#
set -euo pipefail

PORT="${SMOKE_PORT:-4410}"
SANDBOX="$(mktemp -d -t aiops-smoke-XXXXXX)"
SERVER_LOG="$SANDBOX/server.log"
DB_PATH="$SANDBOX/app.db"
PID=""

repo_root() {
  git -C "$(dirname "$0")/.." rev-parse --show-toplevel
}
REPO="$(repo_root)"

cleanup() {
  local exit_code=$?
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    # Give Next.js a beat to close better-sqlite3 cleanly.
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  if [[ $exit_code -ne 0 ]]; then
    echo ""
    echo "=== smoke-install FAILED ==="
    if [[ -f "$SERVER_LOG" ]]; then
      echo "--- last 60 lines of server.log ---"
      tail -n 60 "$SERVER_LOG" || true
    fi
    echo "Sandbox preserved at: $SANDBOX"
  else
    rm -rf "$SANDBOX"
  fi
  exit $exit_code
}
trap cleanup EXIT

say() { printf '\n\033[1;36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[smoke] FAIL:\033[0m %s\n' "$*"; exit 1; }

cd "$REPO"

# ── 1. Sanity
say "Sandbox: $SANDBOX"
say "Port:    $PORT"

[[ -f "package.json" ]] || fail "not in repo root: $REPO"

# ── 2. Fresh DB (in sandbox, so the real data/app.db isn't touched)
say "Running migrations against fresh SQLite at $DB_PATH"
DATABASE_URL="$DB_PATH" npm run db:migrate --silent \
  > "$SANDBOX/migrate.log" 2>&1 \
  || { cat "$SANDBOX/migrate.log"; fail "db:migrate failed"; }

# Guard: DB must be empty.
USER_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "")
[[ "$USER_COUNT" == "0" ]] || fail "fresh DB had $USER_COUNT users (expected 0)"

# ── 3. Boot the server
say "Booting next dev on port $PORT"
DATABASE_URL="$DB_PATH" \
  AUTH_SECRET="$(openssl rand -hex 32)" \
  AUTH_URL="http://localhost:$PORT" \
  PORT="$PORT" \
  npx next dev -p "$PORT" \
  > "$SERVER_LOG" 2>&1 &
PID=$!

# Poll for readiness (max 40s)
for i in $(seq 1 40); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    fail "server exited during boot"
  fi
  sleep 1
done
curl -fsS "http://localhost:$PORT/api/health" >/dev/null \
  || fail "server did not respond to /api/health within 40s"

# ── 4. Setup token should have been printed to stdout
say "Checking stdout for setup token"
TOKEN=$(grep -Eo "token=[A-Za-z0-9_-]{16,}" "$SERVER_LOG" | head -1 | cut -d= -f2 || true)
[[ -n "$TOKEN" ]] || fail "no 'token=...' marker in server log"
say "Found token: ${TOKEN:0:8}…"

# ── 5. /setup should load without auth when token is present
say "Hitting /setup?token=…"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:$PORT/setup?token=$TOKEN")
[[ "$HTTP_CODE" == "200" ]] || fail "/setup returned HTTP $HTTP_CODE (expected 200)"

# ── 6. POST /api/setup/save with a trivial valid payload
say "POST /api/setup/save"
SAVE_BODY=$(curl -s -X POST \
  "http://localhost:$PORT/api/setup/save?token=$TOKEN" \
  -H "content-type: application/json" \
  -d '{"values":{"ALLOWED_EMAIL_DOMAINS":"multiportal.io,example.com"}}')
echo "$SAVE_BODY" | grep -q '"saved"' \
  || fail "save endpoint response missing 'saved' key: $SAVE_BODY"

# ── 7. Verify the row landed in settings
say "Verifying row in settings table"
DB_VAL=$(sqlite3 "$DB_PATH" \
  "SELECT value FROM settings WHERE key='ALLOWED_EMAIL_DOMAINS';")
[[ "$DB_VAL" == '"multiportal.io,example.com"' ]] \
  || fail "settings row mismatch: got $DB_VAL"

# ── 8. Token reuse after user creation would be tested in /auth flow —
#       that requires real Google OAuth so we only assert the token is
#       still valid mid-wizard (no user yet).
say "Token still valid (no admin signed in yet)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:$PORT/setup?token=$TOKEN")
[[ "$HTTP_CODE" == "200" ]] || fail "/setup token rejected mid-flow (HTTP $HTTP_CODE)"

say "All smoke checks passed ✓"
