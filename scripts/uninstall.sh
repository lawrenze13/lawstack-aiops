#!/usr/bin/env bash
#
# Remove a LawStack/aiops install that was set up via scripts/install.sh.
#
# Usage:
#   sudo bash uninstall.sh \
#     --domain aiops.example.com \
#     [--install-dir /var/www/aiops.example.com] \
#     [--worktree-root /var/aiops/worktrees] \
#     [--purge-data]   # also delete the SQLite DB + worktrees
#     [--purge-env]    # also delete the .env (secrets)
#     [--dry-run]
#
# What it removes by default:
#   - stops + disables the systemd unit
#   - removes /etc/systemd/system/<slug>-aiops.service
#   - removes the Caddy block for <domain>
#   - reloads systemd + Caddy
#
# What it PRESERVES by default:
#   - the install directory (keep the built app + git history)
#   - .env (keeps secrets + AUTH_SECRET — deleting strands existing sessions)
#   - /var/aiops/worktrees (keeps agent work product + DBs)
#
# Pass --purge-data + --purge-env for a scorched-earth removal.
#
set -euo pipefail

DOMAIN=""
INSTALL_DIR=""
WORKTREE_ROOT=/var/aiops/worktrees
PURGE_DATA=0
PURGE_ENV=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
	case $1 in
		--domain)         DOMAIN=$2; shift 2 ;;
		--install-dir)    INSTALL_DIR=$2; shift 2 ;;
		--worktree-root)  WORKTREE_ROOT=$2; shift 2 ;;
		--purge-data)     PURGE_DATA=1; shift ;;
		--purge-env)      PURGE_ENV=1; shift ;;
		--dry-run)        DRY_RUN=1; shift ;;
		-h|--help)
			sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //; s/^#$//'
			exit 0
			;;
		*) echo "unknown arg: $1" >&2; exit 1 ;;
	esac
done

[[ -n "$DOMAIN" ]] || { echo "--domain required" >&2; exit 1; }
INSTALL_DIR="${INSTALL_DIR:-/var/www/$DOMAIN}"
APP_SLUG="$(echo "$DOMAIN" | cut -d. -f1)-aiops"

log()  { printf '\033[1;36m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[uninstall] WARN:\033[0m %s\n' "$*"; }
run()  { if (( DRY_RUN )); then printf '\033[1;34m[dry-run]\033[0m %s\n' "$*"; else eval "$*"; fi; }

[[ $EUID -eq 0 ]] || { echo "must run as root (use sudo)" >&2; exit 1; }

log "Uninstalling $APP_SLUG ($DOMAIN)"
(( DRY_RUN )) && log "DRY-RUN mode: no mutations"

# ─── Stop + remove systemd unit ──────────────────────────────────────────────
UNIT_FILE="/etc/systemd/system/$APP_SLUG.service"
if [[ -f "$UNIT_FILE" ]]; then
	log "stopping + disabling $APP_SLUG"
	run "systemctl stop '$APP_SLUG' || true"
	run "systemctl disable '$APP_SLUG' || true"
	run "rm -f '$UNIT_FILE'"
	run "systemctl daemon-reload"
	run "systemctl reset-failed '$APP_SLUG' 2>/dev/null || true"
else
	log "systemd unit $UNIT_FILE not found — skipping"
fi

# ─── Remove the Caddy block ──────────────────────────────────────────────────
CADDYFILE=/etc/caddy/Caddyfile
if [[ -f "$CADDYFILE" ]] && grep -q "^$DOMAIN {" "$CADDYFILE"; then
	log "removing Caddy block for $DOMAIN"
	BACKUP="$CADDYFILE.before-remove-$APP_SLUG-$(date +%s)"
	run "cp '$CADDYFILE' '$BACKUP'"

	# Strip the block: everything from `^$DOMAIN {` to the matching `^}`.
	# awk handles nested braces correctly inside a single site-block.
	if (( !DRY_RUN )); then
		awk -v dom="$DOMAIN" '
			BEGIN { in_block=0; depth=0 }
			!in_block && $0 ~ "^"dom" {" { in_block=1; depth=1; next }
			in_block {
				# Count braces to find the closing one
				n=split($0, _, "{"); depth += n-1
				n=split($0, _, "}"); depth -= n-1
				if (depth <= 0) { in_block=0 }
				next
			}
			{ print }
		' "$CADDYFILE" > "$CADDYFILE.new"
		mv "$CADDYFILE.new" "$CADDYFILE"
	fi

	if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
		run "systemctl reload caddy"
	else
		warn "caddy validate failed after block removal — reverting"
		run "cp '$BACKUP' '$CADDYFILE'"
	fi
else
	log "Caddy block for $DOMAIN not found — skipping"
fi

# ─── Optional purges ─────────────────────────────────────────────────────────
if (( PURGE_ENV )) && [[ -f "$INSTALL_DIR/.env" ]]; then
	log "removing $INSTALL_DIR/.env (--purge-env)"
	run "rm -f '$INSTALL_DIR/.env'"
fi

if (( PURGE_DATA )); then
	if [[ -d "$INSTALL_DIR/data" ]]; then
		log "removing $INSTALL_DIR/data (SQLite DB) — --purge-data"
		run "rm -rf '$INSTALL_DIR/data'"
	fi
	if [[ -d "$WORKTREE_ROOT" ]]; then
		log "removing $WORKTREE_ROOT (all agent worktrees) — --purge-data"
		run "rm -rf '$WORKTREE_ROOT'"
	fi
fi

# ─── Done ────────────────────────────────────────────────────────────────────
log ""
log "✓ uninstall complete"
log ""
log "Still on disk (preserved intentionally):"
[[ -d "$INSTALL_DIR" ]]            && log "  $INSTALL_DIR  (app source + .next/ build)"
[[ -f "$INSTALL_DIR/.env" ]]       && log "  $INSTALL_DIR/.env  (secrets)"
[[ -d "$INSTALL_DIR/data" ]]       && log "  $INSTALL_DIR/data  (SQLite DB)"
[[ -d "$WORKTREE_ROOT" ]]          && log "  $WORKTREE_ROOT  (agent worktrees)"
log ""
log "To remove the app source entirely:  sudo rm -rf $INSTALL_DIR"
log "To remove all Caddy backups:        ls /etc/caddy/Caddyfile.before-*"
