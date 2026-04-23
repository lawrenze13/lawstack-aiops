#!/usr/bin/env bash
#
# One-shot installer for LawStack/aiops.
#
# Usage:
#   sudo bash install.sh \
#     --domain aiops.example.com \
#     --user deploy \
#     [--install-dir /var/www/aiops.example.com] \
#     [--port 3300] \
#     [--branch main] \
#     [--repo https://github.com/you/lawstack-aiops.git] \
#     [--worktree-root /var/aiops/worktrees] \
#     [--dry-run]
#
# What it does:
#   1. Preflight checks (OS, sudo, Caddy, DNS, ports)
#   2. Installs Node 20 via nvm (for --user) if missing
#   3. Clones repo, generates .env, builds, migrates
#   4. Installs systemd unit + appends Caddy block
#   5. Starts service, waits for /api/health
#   6. Prints the SETUP REQUIRED URL + Google OAuth redirect URI
#
# Re-runs are safe: existing .env is preserved, Caddy block appended only
# if the host isn't already present, service restart is idempotent.
#
set -euo pipefail

# ─── Args ────────────────────────────────────────────────────────────────────
DOMAIN=""
INSTALL_DIR=""
USER_NAME=""
PORT=3300
BRANCH=main
REPO="https://github.com/lawrenze13/lawstack-aiops.git"
WORKTREE_ROOT=/var/aiops/worktrees
DRY_RUN=0

while [[ $# -gt 0 ]]; do
	case $1 in
		--domain)         DOMAIN=$2; shift 2 ;;
		--install-dir)    INSTALL_DIR=$2; shift 2 ;;
		--user)           USER_NAME=$2; shift 2 ;;
		--port)           PORT=$2; shift 2 ;;
		--branch)         BRANCH=$2; shift 2 ;;
		--repo)           REPO=$2; shift 2 ;;
		--worktree-root)  WORKTREE_ROOT=$2; shift 2 ;;
		--dry-run)        DRY_RUN=1; shift ;;
		-h|--help)
			sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //; s/^#$//'
			exit 0
			;;
		*) echo "unknown arg: $1" >&2; exit 1 ;;
	esac
done

# Required
[[ -n "$DOMAIN" ]]    || { echo "--domain required" >&2; exit 1; }
[[ -n "$USER_NAME" ]] || { echo "--user required" >&2; exit 1; }
# Default install-dir if unset
INSTALL_DIR="${INSTALL_DIR:-/var/www/$DOMAIN}"
# App-slug for the systemd unit name (one-word, domain-derived)
APP_SLUG="$(echo "$DOMAIN" | cut -d. -f1)-aiops"

# ─── Output helpers ──────────────────────────────────────────────────────────
log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install] WARN:\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[install] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY_RUN )); then printf '\033[1;34m[dry-run]\033[0m %s\n' "$*"; else eval "$*"; fi; }

log "Installing $APP_SLUG → $DOMAIN at $INSTALL_DIR"
(( DRY_RUN )) && log "DRY-RUN mode: no mutations will occur"

# ─── Preflight ───────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]]                        || fail "must run as root (use sudo)"
command -v systemctl >/dev/null          || fail "systemd is required"
command -v caddy >/dev/null              || fail "Caddy 2.x not installed (run: curl -fsSL https://get.caddyserver.com/linux/install.sh | bash)"
command -v git >/dev/null                || fail "git not installed"
command -v openssl >/dev/null            || fail "openssl not installed"
command -v curl >/dev/null               || fail "curl not installed"
command -v sqlite3 >/dev/null            || warn "sqlite3 CLI not installed — fine, but you won't be able to inspect the DB directly"
id "$USER_NAME" >/dev/null 2>&1          || fail "user '$USER_NAME' does not exist (create it first: useradd -m -s /bin/bash $USER_NAME)"
[[ -w /etc/systemd/system ]]             || fail "cannot write to /etc/systemd/system"
[[ -w /etc/caddy ]] || [[ ! -e /etc/caddy/Caddyfile ]] || fail "cannot write to /etc/caddy"

# DNS sanity check (warn only — cert will just fail to provision until fixed)
EXPECTED_IP=$(curl -s https://api.ipify.org || true)
ACTUAL_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
if [[ -n "$EXPECTED_IP" && -n "$ACTUAL_IP" && "$EXPECTED_IP" != "$ACTUAL_IP" ]]; then
	warn "DNS: $DOMAIN resolves to '$ACTUAL_IP' but this VPS is $EXPECTED_IP"
	warn "Caddy won't be able to obtain a Let's Encrypt cert until DNS is fixed."
elif [[ -z "$ACTUAL_IP" ]]; then
	warn "DNS: $DOMAIN does not resolve. Add an A record pointing at $EXPECTED_IP before TLS will work."
fi

# Port conflict check
if ss -ltnp 2>/dev/null | grep -q ":$PORT\b"; then
	fail "port $PORT is already in use. Pick another with --port or stop the holder."
fi

# ─── Node 20 via nvm for the service user ────────────────────────────────────
NVM_DIR_U="$(sudo -u "$USER_NAME" bash -lc 'echo ${NVM_DIR:-$HOME/.nvm}')"
if ! sudo -u "$USER_NAME" bash -lc '[[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]'; then
	log "installing nvm for user $USER_NAME"
	run "sudo -u '$USER_NAME' bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash'"
fi
log "ensuring Node 20 is installed for $USER_NAME"
run "sudo -u '$USER_NAME' bash -lc 'source \$HOME/.nvm/nvm.sh && nvm install 20 && nvm alias default 20 >/dev/null'"

NODE_BIN_DIR=$(sudo -u "$USER_NAME" bash -lc 'source $HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && dirname $(which npm)')
[[ -x "$NODE_BIN_DIR/npm" ]] || fail "could not resolve npm path for $USER_NAME (got: $NODE_BIN_DIR/npm)"
log "node bin dir: $NODE_BIN_DIR"

# ─── Directories ─────────────────────────────────────────────────────────────
run "mkdir -p '$WORKTREE_ROOT'"
run "chown -R '$USER_NAME:$USER_NAME' '$WORKTREE_ROOT'"
run "mkdir -p /var/log/caddy"  # Caddy log dir

# ─── Clone or update the app ─────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
	log "updating existing checkout at $INSTALL_DIR"
	run "sudo -u '$USER_NAME' git -C '$INSTALL_DIR' fetch origin"
	run "sudo -u '$USER_NAME' git -C '$INSTALL_DIR' checkout '$BRANCH'"
	run "sudo -u '$USER_NAME' git -C '$INSTALL_DIR' pull --ff-only"
elif [[ -e "$INSTALL_DIR" ]]; then
	fail "$INSTALL_DIR exists and isn't a git checkout — rename it or use --install-dir elsewhere"
else
	log "cloning $REPO (branch $BRANCH) → $INSTALL_DIR"
	run "install -d -o '$USER_NAME' -g '$USER_NAME' '$(dirname "$INSTALL_DIR")'"
	run "sudo -u '$USER_NAME' git clone --branch '$BRANCH' '$REPO' '$INSTALL_DIR'"
fi

# ─── .env (only if missing) ──────────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
	log "generating .env (AUTH_SECRET auto-generated)"
	AUTH_SECRET=$(openssl rand -hex 32)
	if (( !DRY_RUN )); then
		sed \
			-e "s|__AUTH_SECRET__|$AUTH_SECRET|" \
			-e "s|__AUTH_URL__|https://$DOMAIN|" \
			-e "s|__WORKTREE_ROOT__|$WORKTREE_ROOT|" \
			"$INSTALL_DIR/scripts/install/env.template" > "$INSTALL_DIR/.env"
		chown "$USER_NAME:$USER_NAME" "$INSTALL_DIR/.env"
		chmod 600 "$INSTALL_DIR/.env"
	fi
else
	log ".env already exists — leaving it alone"
fi

# ─── Install deps + migrate + build ──────────────────────────────────────────
log "npm ci + db:migrate + build (this takes a minute)"
run "sudo -u '$USER_NAME' bash -lc '
	cd \"$INSTALL_DIR\" &&
	source \$HOME/.nvm/nvm.sh && nvm use 20 &&
	npm ci &&
	npm run db:migrate &&
	npm run build
'"

# ─── Render + install systemd unit ───────────────────────────────────────────
UNIT_FILE="/etc/systemd/system/$APP_SLUG.service"
log "writing systemd unit: $UNIT_FILE"
if (( !DRY_RUN )); then
	sed \
		-e "s|__APP_NAME__|$APP_SLUG|g" \
		-e "s|__USER__|$USER_NAME|g" \
		-e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
		-e "s|__PORT__|$PORT|g" \
		-e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
		"$INSTALL_DIR/scripts/install/systemd-unit.template" > "$UNIT_FILE"
	chmod 644 "$UNIT_FILE"
fi

run "systemctl daemon-reload"
run "systemctl enable '$APP_SLUG'"
run "systemctl reset-failed '$APP_SLUG' 2>/dev/null || true"
run "systemctl restart '$APP_SLUG'"

# ─── Caddy block (idempotent) ────────────────────────────────────────────────
CADDYFILE=/etc/caddy/Caddyfile
if [[ ! -f "$CADDYFILE" ]]; then
	log "creating $CADDYFILE"
	run "touch '$CADDYFILE'"
fi

if grep -q "^$DOMAIN {" "$CADDYFILE" 2>/dev/null; then
	log "Caddy block for $DOMAIN already present — skipping"
else
	log "appending Caddy block for $DOMAIN"
	BACKUP="$CADDYFILE.before-$APP_SLUG-$(date +%s)"
	run "cp '$CADDYFILE' '$BACKUP'"
	if (( !DRY_RUN )); then
		{
			printf '\n'
			sed \
				-e "s|__DOMAIN__|$DOMAIN|g" \
				-e "s|__PORT__|$PORT|g" \
				"$INSTALL_DIR/scripts/install/caddy-block.template"
		} >> "$CADDYFILE"
	fi

	# Validate; revert on failure
	if ! caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
		warn "caddy validate FAILED after append — reverting"
		run "cp '$BACKUP' '$CADDYFILE'"
		fail "your Caddyfile is unchanged. Check output of: caddy validate --config $CADDYFILE"
	fi
	run "systemctl reload caddy || systemctl restart caddy"
fi

# ─── Wait for /api/health ────────────────────────────────────────────────────
log "waiting up to 60s for http://localhost:$PORT/api/health"
if (( !DRY_RUN )); then
	OK=0
	for _ in $(seq 1 60); do
		if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
			OK=1
			break
		fi
		sleep 1
	done
	if (( !OK )); then
		warn "/api/health didn't respond within 60s — tailing last 30 log lines:"
		journalctl -u "$APP_SLUG" -n 30 --no-pager || true
		fail "service didn't start cleanly"
	fi
fi

# ─── Print the setup URL + OAuth redirect ────────────────────────────────────
log ""
log "╭──────────────────────────────────────────────────────────────╮"
log "│                    ✓  INSTALL COMPLETE                       │"
log "╰──────────────────────────────────────────────────────────────╯"
log ""
log "App URL:         https://$DOMAIN"
log "Service:         $APP_SLUG"
log "Install dir:     $INSTALL_DIR"
log "Worktree root:   $WORKTREE_ROOT"
log ""
log "Day-to-day commands:"
log "  sudo systemctl status $APP_SLUG"
log "  journalctl -u $APP_SLUG -f"
log "  cd $INSTALL_DIR && git pull && npm ci && npm run build && sudo systemctl restart $APP_SLUG"
log ""
log "── First-run setup URL (grab from journal) ───────────────────"
journalctl -u "$APP_SLUG" --since "10 min ago" -o cat 2>/dev/null | \
	grep -A2 "SETUP REQUIRED" | head -5 || \
	log "  (none yet — hit https://$DOMAIN/setup after DNS + TLS are up)"
log ""
log "── Google OAuth — add this redirect URI ──────────────────────"
log "  https://$DOMAIN/api/auth/callback/google"
log ""
log "── Caddy TLS ─────────────────────────────────────────────────"
log "  Caddy will issue a Let's Encrypt cert on first HTTPS request."
log "  If curl -I https://$DOMAIN/api/health returns a self-signed cert,"
log "  DNS hasn't propagated or port 80 is firewalled — check:"
log "    sudo journalctl -u caddy -n 30 --no-pager | grep -iE 'acme|cert'"
