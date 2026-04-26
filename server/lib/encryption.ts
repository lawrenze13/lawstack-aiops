// Intentionally NOT importing 'server-only' — transitively loaded by
// the migrate CLI via server/lib/config.ts → encrypt/decrypt for
// at-rest secret keys. Next.js still tree-shakes this out of client
// bundles; direct client imports would fail on `node:crypto`.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// AES-256-GCM encrypt/decrypt for at-rest secrets stored in
// user_prefs.credentialsJson and the secret-keyed rows of `settings`
// (JIRA_API_TOKEN, GITHUB_TOKEN). Generic primitive — AAD is supplied
// by the caller so the same module can serve future encrypted-at-rest
// features (webhook secrets, OAuth refresh, etc.).
//
// References:
// - NIST SP 800-38D §5.2.1.1 (96-bit IVs are recommended)
// - NIST SP 800-133 §6.2 (HKDF IKM entropy minimum)
// - RFC 5869 §3.1–3.2 (HKDF salt + info parameters)
// - https://nodejs.org/api/crypto.html#class-cipher

// ─── Branded types ────────────────────────────────────────────────────────────

declare const __brandCiphertext: unique symbol;
declare const __brandPlaintext: unique symbol;

/**
 * Opaque envelope produced by `encrypt`. Format:
 * `enc:v1:<base64url(IV(12) ‖ CIPHERTEXT ‖ TAG(16))>`. Storing one of
 * these in a column requires a `Plaintext` round-trip through
 * `decrypt`; trying to assign a plain `string` is a compile error.
 */
export type Ciphertext = string & { readonly [__brandCiphertext]: true };

/**
 * Opaque token marking a `string` as decrypted (or never-encrypted)
 * material. Use `asPlaintext` to construct from raw user input.
 */
export type Plaintext = string & { readonly [__brandPlaintext]: true };

/** Construct a `Plaintext` from a raw string (e.g. operator input). */
export function asPlaintext(s: string): Plaintext {
  return s as Plaintext;
}

/** Returns true iff the value carries the `enc:v1:` prefix. Use for
 *  cheap presence detection (e.g. migration: "is this row already
 *  encrypted?"). For structured parsing use {@link parseEnvelope}. */
export function isCiphertext(s: string): s is Ciphertext {
  return s.startsWith(ENVELOPE_PREFIX);
}

// ─── Envelope format ──────────────────────────────────────────────────────────

const ENVELOPE_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

export type EnvelopeParseError =
  | "wrong-prefix"
  | "bad-base64"
  | "short-iv"
  | "short-tag"
  | "unknown-version";

export type EnvelopeParseResult =
  | { ok: true; iv: Buffer; ciphertext: Buffer; tag: Buffer }
  | { ok: false; error: EnvelopeParseError };

/**
 * Parse an `enc:v1:` envelope into its three byte components without
 * attempting to decrypt. Returns a typed error so callers can
 * distinguish "wrong prefix" (treat as plaintext) from "corrupt"
 * (audit + fall through).
 */
export function parseEnvelope(s: string): EnvelopeParseResult {
  if (!s.startsWith(ENVELOPE_PREFIX)) {
    // Future versions ("enc:v2:...") get a distinct error so callers
    // can surface a specific upgrade message.
    if (s.startsWith("enc:") && !s.startsWith(ENVELOPE_PREFIX)) {
      return { ok: false, error: "unknown-version" };
    }
    return { ok: false, error: "wrong-prefix" };
  }
  const body = s.slice(ENVELOPE_PREFIX.length);
  let raw: Buffer;
  try {
    raw = Buffer.from(body, "base64url");
    if (raw.length === 0) return { ok: false, error: "bad-base64" };
  } catch {
    return { ok: false, error: "bad-base64" };
  }
  if (raw.length < IV_BYTES + 1 + TAG_BYTES) {
    // Need at least 1 byte of ciphertext between IV and tag.
    return raw.length < IV_BYTES
      ? { ok: false, error: "short-iv" }
      : { ok: false, error: "short-tag" };
  }
  const iv = raw.subarray(0, IV_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  return { ok: true, iv, ciphertext, tag };
}

// ─── Key derivation ───────────────────────────────────────────────────────────

// Constant 32-byte salt — public, committed. RFC 5869 §3.1 explicitly
// allows non-secret salt; a fixed application-specific value is the
// canonical pattern (mirrors QUIC's fixed-salt derivation).
const K_SALT = createHash("sha256").update("aiops.token-encryption.v1").digest();
const K_INFO = "aiops:user_prefs:tokens:aes-256-gcm:v1";

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const explicit = process.env.TOKEN_ENCRYPTION_KEY;
  if (explicit) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(explicit, "base64");
    } catch {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must be base64-encoded; failed to decode.",
      );
    }
    if (bytes.length !== KEY_BYTES) {
      throw new Error(
        `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes; got ${bytes.length}.`,
      );
    }
    cachedKey = bytes;
    return cachedKey;
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    throw new Error(
      "Encryption key unavailable: set TOKEN_ENCRYPTION_KEY (32-byte base64) or AUTH_SECRET (≥32 chars).",
    );
  }
  // NIST SP 800-133 §6.2: IKM should carry ≥128 bits of effective
  // entropy. 32 ASCII chars ≈ 192 bits when randomly drawn from
  // base64-style alphabet; 32 raw bytes ≈ 256 bits. We require the
  // string length, not the byte count, to match the existing
  // configSchema's `z.string().min(32)` invariant.
  if (authSecret.length < 32) {
    throw new Error(
      `AUTH_SECRET is ${authSecret.length} chars; must be ≥32 to derive an encryption key.`,
    );
  }
  const ikm = Buffer.from(authSecret, "utf8");
  const derived = hkdfSync("sha256", ikm, K_SALT, K_INFO, KEY_BYTES);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/** Test-only: clear the cached key so a subsequent call re-derives.
 *  Production code must NOT call this. */
export function __resetKeyForTest(): void {
  cachedKey = null;
}

// ─── encrypt / decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt plaintext to an `enc:v1:` envelope. AAD is bound into the
 * GCM auth tag and must match exactly on decrypt — callers compose
 * AAD from `userId + fieldPath` (or equivalent) to prevent
 * cross-row / cross-field ciphertext swaps.
 */
export function encrypt(plaintext: Plaintext, aad: string): Ciphertext {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([iv, enc, tag]).toString("base64url");
  return (ENVELOPE_PREFIX + body) as Ciphertext;
}

/**
 * Decrypt an `enc:v1:` envelope. Throws on bad envelope shape OR
 * AAD/tag mismatch (`DecryptionFailureError`). Callers fall back to
 * instance defaults on failure and audit `credentials.decrypt_failure`.
 */
export function decrypt(envelope: Ciphertext, aad: string): Plaintext {
  const parsed = parseEnvelope(envelope);
  if (!parsed.ok) {
    throw new DecryptionFailureError(`envelope ${parsed.error}`);
  }
  const key = loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(parsed.tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
  } catch (err) {
    // Authentication failure (wrong key, wrong AAD, tampered tag) —
    // surface as a typed error, never as a generic crypto throw.
    throw new DecryptionFailureError(
      `auth-tag verification failed: ${(err as Error).message}`,
    );
  }
  return plaintext.toString("utf8") as Plaintext;
}

export class DecryptionFailureError extends Error {
  constructor(message: string) {
    super(`decryption failed: ${message}`);
    this.name = "DecryptionFailureError";
  }
}
