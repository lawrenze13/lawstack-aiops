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
# ── Install modes ────────────────────────────────────────────────────────────
# full  — systemd + Caddy + Let's Encrypt TLS. Requires --domain + --user.
#         For fresh VPS deploys with a public domain.
# proxy — systemd service only. No Caddy. User supplies their own reverse
#         proxy (nginx, Cloudflare Tunnel, etc.). Requires --user, optional
#         --domain for AUTH_URL.
# local — No systemd, no Caddy. Background process via pidfile on
#         localhost:PORT. Works without sudo if PORT > 1024. Great for
#         laptops, home servers, trying it out. No --user / --domain needed.
MODE=full

while [[ $# -gt 0 ]]; do
	case $1 in
		--mode)           MODE=$2; shift 2 ;;
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

# ─── Validate mode + required flags ──────────────────────────────────────────
case "$MODE" in
	full)
		[[ -n "$DOMAIN" ]]    || { echo "--domain required for --mode full" >&2; exit 1; }
		[[ -n "$USER_NAME" ]] || { echo "--user required for --mode full" >&2; exit 1; }
		INSTALL_DIR="${INSTALL_DIR:-/var/www/$DOMAIN}"
		APP_SLUG="$(echo "$DOMAIN" | cut -d. -f1)-aiops"
		;;
	proxy)
		[[ -n "$USER_NAME" ]] || { echo "--user required for --mode proxy" >&2; exit 1; }
		INSTALL_DIR="${INSTALL_DIR:-/var/www/${DOMAIN:-aiops}}"
		APP_SLUG="${DOMAIN:+$(echo "$DOMAIN" | cut -d. -f1)-}aiops"
		APP_SLUG="${APP_SLUG%-}"
		;;
	local)
		# No sudo required if PORT > 1024. Install under the invoking user's home.
		INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/lawstack-aiops}"
		APP_SLUG="aiops-local"
		# AUTH_URL defaults to localhost for the mode's setup URL shape.
		DOMAIN="${DOMAIN:-localhost:$PORT}"
		# Worktree root must be user-writable in local mode — can't touch
		# /var/aiops/worktrees without sudo. Nest it under INSTALL_DIR.
		if [[ "$WORKTREE_ROOT" == "/var/aiops/worktrees" ]]; then
			WORKTREE_ROOT="$INSTALL_DIR/worktrees"
		fi
		;;
	*)
		echo "unknown --mode '$MODE' (expected: full|proxy|local)" >&2
		exit 1
		;;
esac

# ─── Output helpers ──────────────────────────────────────────────────────────
log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install] WARN:\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[install] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY_RUN )); then printf '\033[1;34m[dry-run]\033[0m %s\n' "$*"; else eval "$*"; fi; }

log "Installing $APP_SLUG → $DOMAIN at $INSTALL_DIR"
(( DRY_RUN )) && log "DRY-RUN mode: no mutations will occur"

# ─── Preflight ───────────────────────────────────────────────────────────────
command -v git >/dev/null                || fail "git not installed"
command -v openssl >/dev/null            || fail "openssl not installed"
command -v curl >/dev/null               || fail "curl not installed"
command -v sqlite3 >/dev/null            || warn "sqlite3 CLI not installed — fine, but you won't be able to inspect the DB directly"

# Mode-specific preflight
case "$MODE" in
	full|proxy)
		[[ $EUID -eq 0 ]]                        || fail "modes 'full' and 'proxy' require root (use sudo)"
		command -v systemctl >/dev/null          || fail "systemd is required for $MODE mode"
		id "$USER_NAME" >/dev/null 2>&1          || fail "user '$USER_NAME' does not exist (create it first: useradd -m -s /bin/bash $USER_NAME)"
		[[ -w /etc/systemd/system ]]             || fail "cannot write to /etc/systemd/system"
		;;
	local)
		[[ $EUID -eq 0 ]]                        && warn "local mode doesn't need sudo — you're running as root, which is fine but unusual"
		;;
esac

# Caddy is only required for full mode
if [[ "$MODE" == "full" ]]; then
	if ! command -v caddy >/dev/null; then
		if command -v apt-get >/dev/null; then
			log "Caddy not found — installing via official apt repo"
			run "apt-get update -qq"
			run "apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg"
			run "curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
			run "curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list"
			run "apt-get update -qq && apt-get install -y -qq caddy"
		else
			fail "Caddy 2.x not installed AND apt-get not available. See https://caddyserver.com/docs/install"
		fi
	fi
	command -v caddy >/dev/null              || fail "Caddy install failed — check apt output above"
	[[ -w /etc/caddy ]] || [[ ! -e /etc/caddy/Caddyfile ]] || fail "cannot write to /etc/caddy"
fi

# DNS sanity check — only meaningful for full mode with auto-TLS
if [[ "$MODE" == "full" ]]; then
EXPECTED_IP=$(curl -s https://api.ipify.org || true)
ACTUAL_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
if [[ -n "$EXPECTED_IP" && -n "$ACTUAL_IP" && "$EXPECTED_IP" != "$ACTUAL_IP" ]]; then
	warn "DNS: $DOMAIN resolves to '$ACTUAL_IP' but this VPS is $EXPECTED_IP"
	warn "Caddy won't be able to obtain a Let's Encrypt cert until DNS is fixed."
elif [[ -z "$ACTUAL_IP" ]]; then
	warn "DNS: $DOMAIN does not resolve. Add an A record pointing at $EXPECTED_IP before TLS will work."
fi
fi  # end: DNS check only for full mode

# Port conflict check (always)
if ss -ltnp 2>/dev/null | grep -q ":$PORT\b"; then
	fail "port $PORT is already in use. Pick another with --port or stop the holder."
fi

# ─── Node 20 via nvm ─────────────────────────────────────────────────────────
# For full/proxy modes, set up Node under the service user ($USER_NAME).
# For local mode, set up Node under the invoking user ($USER).
if [[ "$MODE" == "local" ]]; then
	RUNAS_USER="$(whoami)"
else
	RUNAS_USER="$USER_NAME"
fi

as_user() {
	if [[ "$RUNAS_USER" == "$(whoami)" ]]; then
		bash -lc "$*"
	else
		sudo -u "$RUNAS_USER" bash -lc "$*"
	fi
}

if ! as_user '[[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]'; then
	log "installing nvm for user $RUNAS_USER"
	if [[ "$RUNAS_USER" == "$(whoami)" ]]; then
		run "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
	else
		run "sudo -u '$RUNAS_USER' bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash'"
	fi
fi
log "ensuring Node 20 is installed for $RUNAS_USER"
if [[ "$RUNAS_USER" == "$(whoami)" ]]; then
	run "bash -lc 'source \$HOME/.nvm/nvm.sh && nvm install 20 && nvm alias default 20 >/dev/null'"
else
	run "sudo -u '$RUNAS_USER' bash -lc 'source \$HOME/.nvm/nvm.sh && nvm install 20 && nvm alias default 20 >/dev/null'"
fi

# Resolve the npm path for whichever user will run the service/process.
if [[ "$MODE" == "local" ]]; then
	NODE_BIN_DIR=$(bash -lc 'source $HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && dirname $(which npm)')
else
	NODE_BIN_DIR=$(sudo -u "$USER_NAME" bash -lc 'source $HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && dirname $(which npm)')
fi
[[ -x "$NODE_BIN_DIR/npm" ]] || fail "could not resolve npm path for $RUNAS_USER (got: $NODE_BIN_DIR/npm)"
log "node bin dir: $NODE_BIN_DIR"

# Install Claude CLI globally for whichever user will spawn agent runs.
# Without `claude` on PATH, agent runs fail with ENOENT at subprocess spawn.
if [[ "$MODE" == "local" ]]; then
	HAS_CLAUDE=$(bash -lc 'source $HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && command -v claude >/dev/null && echo yes || echo no')
else
	HAS_CLAUDE=$(sudo -u "$USER_NAME" bash -lc 'source $HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && command -v claude >/dev/null && echo yes || echo no')
fi
if [[ "$HAS_CLAUDE" != "yes" ]]; then
	log "installing @anthropic-ai/claude-code globally for $RUNAS_USER"
	if [[ "$MODE" == "local" ]]; then
		run "bash -lc 'source \$HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && npm install -g @anthropic-ai/claude-code'"
	else
		run "sudo -u '$USER_NAME' bash -lc 'source \$HOME/.nvm/nvm.sh && nvm use 20 >/dev/null && npm install -g @anthropic-ai/claude-code'"
	fi
fi

# Verify claude CLI lives at the PATH we'll hand to the service.
if ! [[ -x "$NODE_BIN_DIR/claude" ]]; then
	warn "claude CLI not found at $NODE_BIN_DIR/claude after install"
	warn "agent runs will fail until you: npm install -g @anthropic-ai/claude-code"
fi

# ─── Directories ─────────────────────────────────────────────────────────────
run "mkdir -p '$WORKTREE_ROOT'"
if [[ "$MODE" != "local" ]]; then
	run "chown -R '$USER_NAME:$USER_NAME' '$WORKTREE_ROOT'"
fi
if [[ "$MODE" == "full" ]]; then
	run "mkdir -p /var/log/caddy"
fi

# ─── Clone or update the app ─────────────────────────────────────────────────
GIT_PREFIX=""
if [[ "$MODE" != "local" ]]; then
	GIT_PREFIX="sudo -u $USER_NAME "
fi
if [[ -d "$INSTALL_DIR/.git" ]]; then
	log "updating existing checkout at $INSTALL_DIR"
	run "${GIT_PREFIX}git -C '$INSTALL_DIR' fetch origin"
	run "${GIT_PREFIX}git -C '$INSTALL_DIR' checkout '$BRANCH'"
	run "${GIT_PREFIX}git -C '$INSTALL_DIR' pull --ff-only"
elif [[ -e "$INSTALL_DIR" ]]; then
	fail "$INSTALL_DIR exists and isn't a git checkout — rename it or use --install-dir elsewhere"
else
	log "cloning $REPO (branch $BRANCH) → $INSTALL_DIR"
	if [[ "$MODE" != "local" ]]; then
		run "install -d -o '$USER_NAME' -g '$USER_NAME' '$(dirname "$INSTALL_DIR")'"
	else
		run "mkdir -p '$(dirname "$INSTALL_DIR")'"
	fi
	run "${GIT_PREFIX}git clone --branch '$BRANCH' '$REPO' '$INSTALL_DIR'"
fi

# ─── .env (only if missing) ──────────────────────────────────────────────────
# AUTH_URL format: https://<domain> for full+proxy, http://localhost:PORT for local.
if [[ "$MODE" == "local" ]]; then
	AUTH_URL_VALUE="http://localhost:$PORT"
else
	AUTH_URL_VALUE="https://$DOMAIN"
fi
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
	log "generating .env (AUTH_SECRET auto-generated, AUTH_URL=$AUTH_URL_VALUE)"
	AUTH_SECRET=$(openssl rand -hex 32)
	if (( !DRY_RUN )); then
		sed \
			-e "s|__AUTH_SECRET__|$AUTH_SECRET|" \
			-e "s|__AUTH_URL__|$AUTH_URL_VALUE|" \
			-e "s|__WORKTREE_ROOT__|$WORKTREE_ROOT|" \
			"$INSTALL_DIR/scripts/install/env.template" > "$INSTALL_DIR/.env"
		if [[ "$MODE" != "local" ]]; then
			chown "$USER_NAME:$USER_NAME" "$INSTALL_DIR/.env"
		fi
		chmod 600 "$INSTALL_DIR/.env"
	fi
else
	log ".env already exists — leaving it alone"
fi

# ─── Install deps + migrate + build ──────────────────────────────────────────
log "npm ci + db:migrate + build (this takes a minute)"
if [[ "$MODE" == "local" ]]; then
	run "bash -lc 'cd \"$INSTALL_DIR\" && source \$HOME/.nvm/nvm.sh && nvm use 20 && npm ci && npm run db:migrate && npm run build'"
else
	run "sudo -u '$USER_NAME' bash -lc 'cd \"$INSTALL_DIR\" && source \$HOME/.nvm/nvm.sh && nvm use 20 && npm ci && npm run db:migrate && npm run build'"
fi

# ─── Start the service (mode-specific) ───────────────────────────────────────
if [[ "$MODE" == "local" ]]; then
	log "starting local background process on :$PORT"
	PIDFILE="$INSTALL_DIR/aiops.pid"
	LOGFILE="$INSTALL_DIR/aiops.log"
	# Kill prior instance if pidfile exists + process alive
	if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
		log "stopping prior instance (pid $(cat "$PIDFILE"))"
		run "kill $(cat "$PIDFILE") || true"
		sleep 1
	fi
	if (( !DRY_RUN )); then
		(
			cd "$INSTALL_DIR"
			source "$HOME/.nvm/nvm.sh"
			nvm use 20 >/dev/null
			nohup npm start > "$LOGFILE" 2>&1 &
			echo $! > "$PIDFILE"
		)
		log "started (pid $(cat "$PIDFILE")); logs at $LOGFILE"
	fi
else
	# Render + install systemd unit
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
fi

# ─── Caddy block (full mode only; idempotent) ────────────────────────────────
if [[ "$MODE" == "full" ]]; then
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
fi  # end: Caddy block only for full mode

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
		warn "/api/health didn't respond within 60s — showing recent logs:"
		if [[ "$MODE" == "local" ]]; then
			tail -n 30 "$INSTALL_DIR/aiops.log" 2>/dev/null || true
		else
			journalctl -u "$APP_SLUG" -n 30 --no-pager || true
		fi
		fail "service didn't start cleanly"
	fi
fi

# ─── Print the setup URL + OAuth redirect ────────────────────────────────────
log ""
log "╭──────────────────────────────────────────────────────────────╮"
log "│                    ✓  INSTALL COMPLETE                       │"
log "╰──────────────────────────────────────────────────────────────╯"
log ""
case "$MODE" in
	full)
		log "App URL:        https://$DOMAIN"
		log "Mode:           full (systemd + Caddy + Let's Encrypt)"
		;;
	proxy)
		log "App URL:        http://localhost:$PORT  (wire your own reverse proxy)"
		log "Mode:           proxy (systemd only; no Caddy)"
		;;
	local)
		log "App URL:        http://localhost:$PORT"
		log "Mode:           local (background process, no systemd, no TLS)"
		;;
esac
log "Service:         $APP_SLUG"
log "Install dir:     $INSTALL_DIR"
log ""
log "Day-to-day commands:"
if [[ "$MODE" == "local" ]]; then
	log "  tail -f $INSTALL_DIR/aiops.log                # live logs"
	log "  kill \$(cat $INSTALL_DIR/aiops.pid)             # stop"
	log "  bash $INSTALL_DIR/scripts/install.sh --mode local --install-dir $INSTALL_DIR  # re-install / restart"
else
	log "  sudo systemctl status $APP_SLUG"
	log "  journalctl -u $APP_SLUG -f"
	log "  cd $INSTALL_DIR && git pull && npm ci && npm run build && sudo systemctl restart $APP_SLUG"
fi
log ""
log "── First-run setup URL ───────────────────────────────────────"
if [[ "$MODE" == "local" ]]; then
	log "  open http://localhost:$PORT in a browser"
	log "  or: grep -A2 'SETUP REQUIRED' $INSTALL_DIR/aiops.log"
else
	journalctl -u "$APP_SLUG" --since "10 min ago" -o cat 2>/dev/null | \
		grep -A2 "SETUP REQUIRED" | head -5 || \
		log "  (none yet — hit $AUTH_URL_VALUE/setup after it's reachable)"
fi
log ""
log "── Google OAuth — add this redirect URI ──────────────────────"
log "  $AUTH_URL_VALUE/api/auth/callback/google"
if [[ "$MODE" == "full" ]]; then
	log ""
	log "── Caddy TLS ─────────────────────────────────────────────────"
	log "  Caddy will issue a Let's Encrypt cert on first HTTPS request."
	log "  If curl -I https://$DOMAIN/api/health returns a self-signed cert,"
	log "  DNS hasn't propagated or port 80 is firewalled — check:"
	log "    sudo journalctl -u caddy -n 30 --no-pager | grep -iE 'acme|cert'"
fi
