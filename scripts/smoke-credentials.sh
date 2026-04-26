#!/usr/bin/env bash
# Smoke test for the per-user-tokens substrate.
#
# Exercises the LOCAL pieces that don't need real Jira/GitHub creds:
#   1. Migration runner is idempotent + encrypts in place
#   2. setConfig encrypts; getConfig decrypts (round-trip)
#   3. AAD-binding rejects ciphertext from a different field
#   4. resolveCredentials returns the correct discriminated union
#
# Phase 6 of docs/plans/2026-04-26-feat-per-user-tokens-with-instance-fallback-plan.md.
#
# Prereq: better-sqlite3 must be compiled for the same Node version
# you're running. If you see "NODE_MODULE_VERSION ... requires
# NODE_MODULE_VERSION ..." run `nvm use && npm rebuild better-sqlite3`
# before running this script.

set -euo pipefail

cd "$(dirname "$0")/.."

# Use a throwaway DB so this never touches the real one.
SMOKE_DIR="$(mktemp -d -t aiops-smoke-creds-XXXXXX)"
SMOKE_DB="${SMOKE_DIR}/smoke.db"
trap 'rm -rf "${SMOKE_DIR}"' EXIT

export DATABASE_URL="${SMOKE_DB}"
export AUTH_SECRET="$(openssl rand -hex 32)"
export NODE_ENV="${NODE_ENV:-test}"
unset TOKEN_ENCRYPTION_KEY  # Force the HKDF-from-AUTH_SECRET path

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; exit 1; }

cyan "▶ smoke-credentials: DB=${SMOKE_DB}"

# ─── Step 1: apply migrations ────────────────────────────────────────────────
cyan "▶ step 1: npm run db:migrate (chains db:migrate-secrets)"
npm run --silent db:migrate >/tmp/aiops-smoke-migrate.log 2>&1 || \
  red "✗ migrations failed; tail -20 /tmp/aiops-smoke-migrate.log"
green "  ✓ migrations applied"

# Verify the new columns exist.
cols=$(sqlite3 "${SMOKE_DB}" "PRAGMA table_info(runs);" | awk -F'|' '{print $2}' | tr '\n' ' ')
echo "${cols}" | grep -q "jira_token_source" || red "✗ runs.jira_token_source missing"
echo "${cols}" | grep -q "github_token_source" || red "✗ runs.github_token_source missing"
green "  ✓ runs.{jira,github}_token_source exist"

cols=$(sqlite3 "${SMOKE_DB}" "PRAGMA table_info(user_prefs);" | awk -F'|' '{print $2}' | tr '\n' ' ')
echo "${cols}" | grep -q "credentials_json" || red "✗ user_prefs.credentials_json missing"
green "  ✓ user_prefs.credentials_json exists"

# ─── Step 2: encrypt-on-write + decrypt-on-read round-trip ───────────────────
cyan "▶ step 2: setConfig encrypts; getConfig round-trips"
TEST_TOKEN="atatt-pretend-jira-token-$(openssl rand -hex 8)"

ROUND_TRIP_JS=$(cat <<'EOF'
import { setConfig, getConfig } from "@/server/lib/config";
import { db } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import { eq } from "drizzle-orm";

const TEST_TOKEN = process.env.SMOKE_TEST_TOKEN!;

setConfig("JIRA_API_TOKEN", TEST_TOKEN, "smoke-test");

const row = db
  .select({ value: settings.value })
  .from(settings)
  .where(eq(settings.key, "JIRA_API_TOKEN"))
  .get();

if (!row) {
  console.error("FAIL: settings row missing");
  process.exit(1);
}
const parsed = JSON.parse(row.value);
if (typeof parsed !== "string" || !parsed.startsWith("enc:v1:")) {
  console.error(`FAIL: stored value is not enc:v1: envelope; got ${parsed.slice(0, 30)}`);
  process.exit(1);
}
console.log("  stored ciphertext: enc:v1:..." + parsed.slice(7, 25) + "…");

const back = getConfig("JIRA_API_TOKEN", { skipCache: true });
if (back !== TEST_TOKEN) {
  console.error(`FAIL: round-trip mismatch — got '${back}'`);
  process.exit(1);
}
console.log(`  round-trip OK (${TEST_TOKEN.length} chars decrypted)`);
EOF
)

SMOKE_TEST_TOKEN="${TEST_TOKEN}" AIOPS_CLI=1 npx tsx -e "${ROUND_TRIP_JS}" || \
  red "✗ encrypt/decrypt round-trip failed"
green "  ✓ setConfig→DB encrypted; getConfig decrypted to original plaintext"

# ─── Step 3: AAD-binding — cross-key ciphertext fails ────────────────────────
cyan "▶ step 3: AAD-binding rejects swapped ciphertext"

AAD_SWAP_JS=$(cat <<'EOF'
import { encrypt, asPlaintext, decrypt, DecryptionFailureError, type Ciphertext } from "@/server/lib/encryption";

// Encrypt with one AAD, attempt decrypt with another.
const ct = encrypt(asPlaintext("secret-token"), "settings:v1:JIRA_API_TOKEN");
try {
  decrypt(ct, "settings:v1:GITHUB_TOKEN");
  console.error("FAIL: cross-key decrypt did not throw");
  process.exit(1);
} catch (err) {
  if (!(err instanceof DecryptionFailureError)) {
    console.error("FAIL: wrong error type:", err);
    process.exit(1);
  }
  console.log("  cross-key decrypt rejected:", (err as Error).message.slice(0, 80));
}

// Same field — should succeed.
const back = decrypt(ct, "settings:v1:JIRA_API_TOKEN");
if (String(back) !== "secret-token") {
  console.error(`FAIL: same-AAD decrypt mismatch: ${back}`);
  process.exit(1);
}
console.log("  same-key decrypt OK");
EOF
)

AIOPS_CLI=1 npx tsx -e "${AAD_SWAP_JS}" || red "✗ AAD-binding test failed"
green "  ✓ AAD-binding prevents cross-key swap"

# ─── Step 4: idempotent re-run of db:migrate-secrets ─────────────────────────
cyan "▶ step 4: db:migrate-secrets is idempotent (re-run is no-op)"
out=$(npm run --silent db:migrate-secrets 2>&1)
echo "${out}" | grep -q "encrypted=0" || red "✗ second run encrypted something (not idempotent): ${out}"
echo "${out}" | grep -q "skipped=2" || red "✗ second run did not skip both keys: ${out}"
green "  ✓ idempotent"

# ─── Step 5: resolver returns the right source ───────────────────────────────
cyan "▶ step 5: resolveCredentials reflects what's set"

RESOLVER_JS=$(cat <<'EOF'
import { resolveCredentials, resolveAllCredentials } from "@/server/integrations/credentials";

// JIRA_API_TOKEN was set in step 2, but JIRA_BASE_URL/EMAIL were not —
// so jira resolves to 'missing' (incomplete).
const r1 = resolveCredentials(null, "jira");
if (r1.source !== "missing") {
  console.error(`FAIL: expected jira=missing (incomplete instance), got ${r1.source}`);
  process.exit(1);
}
console.log("  jira (no userId, only token configured) → missing ✓");

// github also missing (no token set in this smoke run).
const r2 = resolveCredentials(null, "github");
if (r2.source !== "missing") {
  console.error(`FAIL: expected github=missing, got ${r2.source}`);
  process.exit(1);
}
console.log("  github (nothing set) → missing ✓");

// git always resolves, defaults to hardcoded.
const r3 = resolveCredentials(null, "git");
if (r3.source !== "default") {
  console.error(`FAIL: expected git=default, got ${r3.source}`);
  process.exit(1);
}
console.log(`  git (no userId) → default (${r3.value.name})`);

// resolveAllCredentials shape sanity.
const all = resolveAllCredentials(null);
if (all.jira.service !== "jira" || all.github.service !== "github" || all.git.service !== "git") {
  console.error("FAIL: resolveAllCredentials shape wrong:", all);
  process.exit(1);
}
console.log("  resolveAllCredentials returns all three ✓");
EOF
)

AIOPS_CLI=1 npx tsx -e "${RESOLVER_JS}" || red "✗ resolver smoke test failed"
green "  ✓ resolver returns correct discriminated-union shapes"

# ─── Done ────────────────────────────────────────────────────────────────────
echo
green "✓ smoke-credentials passed"
echo "  DB cleaned up: ${SMOKE_DIR}"
