// Standalone CLI: `npm run db:migrate-secrets`. Backfills the
// `settings` table for KNOWN_SECRET_KEYS — encrypts existing
// plaintext values in place, and bootstraps env-only values into
// settings rows. Idempotent: detects `enc:v1:` prefix and no-ops.
//
// Each key's processing runs inside a `BEGIN IMMEDIATE` transaction
// so two concurrent runs serialise per-key and never produce dual
// encrypted blobs from a single plaintext.
//
// Chained from `npm run db:migrate` so a fresh deploy gets both the
// SQL-table migrations and the secret-encryption pass in one
// invocation.

// Match server/db/migrate-cli.ts: skip the boot reconciler on CLI
// import so we don't eagerly pull in the full worker module graph.
process.env.AIOPS_CLI = "1";

type SkipReason =
  | "already-ciphertext"
  | "empty"
  | "no-env-and-no-row"
  | "non-string-value";

export interface MigrationResult {
  encrypted: string[];
  bootstrapped: string[];
  skipped: Array<{ key: string; reason: SkipReason }>;
  failed: Array<{ key: string; error: string }>;
}

async function main(): Promise<MigrationResult> {
  const { sqlite, db } = await import("./client");
  const { settings } = await import("./schema");
  const { eq } = await import("drizzle-orm");
  const { audit } = await import("../auth/audit");
  const {
    asPlaintext,
    encrypt,
    isCiphertext,
  } = await import("../lib/encryption");
  const { KNOWN_SECRET_KEYS, settingsAad } = await import("../lib/config");

  const result: MigrationResult = {
    encrypted: [],
    bootstrapped: [],
    skipped: [],
    failed: [],
  };

  for (const key of KNOWN_SECRET_KEYS) {
    try {
      const txn = sqlite.transaction(() => {
        const row = db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, key))
          .get();

        if (!row) {
          // No settings row. Bootstrap from env if present.
          const envVal = process.env[key];
          if (!envVal || envVal.length === 0) {
            result.skipped.push({ key, reason: "no-env-and-no-row" });
            return;
          }
          const ciphertext = encrypt(asPlaintext(envVal), settingsAad(key));
          db.insert(settings)
            .values({ key, value: JSON.stringify(ciphertext), updatedBy: null })
            .run();
          audit({
            action: "settings.bootstrapped_from_env",
            payload: { key },
          });
          result.bootstrapped.push(key);
          return;
        }

        // Settings row exists — inspect the JSON-encoded value.
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch (err) {
          result.failed.push({
            key,
            error: `JSON.parse failed: ${(err as Error).message}`,
          });
          return;
        }

        if (typeof parsed !== "string") {
          result.skipped.push({ key, reason: "non-string-value" });
          return;
        }
        if (parsed.length === 0) {
          result.skipped.push({ key, reason: "empty" });
          return;
        }
        if (isCiphertext(parsed)) {
          result.skipped.push({ key, reason: "already-ciphertext" });
          return;
        }

        // Plaintext — encrypt in place.
        const ciphertext = encrypt(asPlaintext(parsed), settingsAad(key));
        db.update(settings)
          .set({ value: JSON.stringify(ciphertext), updatedAt: new Date() })
          .where(eq(settings.key, key))
          .run();
        audit({
          action: "settings.encrypted_at_rest",
          payload: { key },
        });
        result.encrypted.push(key);
      });

      // BEGIN IMMEDIATE — acquires a RESERVED lock at txn start so
      // a concurrent process blocks until we commit. Safer than the
      // default DEFERRED for read-then-write patterns where two
      // processes could both read plaintext, then race to encrypt
      // (yielding two different ciphertexts; one wins, the other's
      // audit row is misleading).
      txn.immediate();
    } catch (err) {
      result.failed.push({ key, error: (err as Error).message });
    }
  }

  return result;
}

// Print summary on direct invocation. Importable as a function for tests.
if (process.argv[1] && /migrate-secrets-cli/.test(process.argv[1])) {
  main()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      const ok = result.failed.length === 0;
      // eslint-disable-next-line no-console
      console.log(
        ok
          ? `✓ secret migration complete (encrypted=${result.encrypted.length}, bootstrapped=${result.bootstrapped.length}, skipped=${result.skipped.length})`
          : `✗ secret migration had ${result.failed.length} failure(s)`,
      );
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("migrate-secrets fatal", err);
      process.exit(1);
    });
}

export { main as migrateInstanceSecrets };
