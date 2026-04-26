import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TEST_AUTH_SECRET = "x".repeat(48); // ≥32 chars
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString("base64"); // 32 bytes of 0x07

let mod: typeof import("@/server/lib/encryption");

async function reload(env: Record<string, string | undefined> = {}): Promise<typeof mod> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const fresh = await import("@/server/lib/encryption");
  fresh.__resetKeyForTest();
  return fresh;
}

beforeEach(async () => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  mod = await reload({ AUTH_SECRET: TEST_AUTH_SECRET });
});

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.AUTH_SECRET;
});

describe("encryption — round-trip", () => {
  it("encrypt then decrypt with the same AAD recovers the plaintext", () => {
    const aad = "user_prefs:tokens:v1:U_abc:jira.apiToken";
    const pt = mod.asPlaintext("super-secret-token-123");
    const ct = mod.encrypt(pt, aad);
    expect(ct.startsWith("enc:v1:")).toBe(true);
    const back = mod.decrypt(ct, aad);
    expect(String(back)).toBe(String(pt));
  });

  it("two encryptions of the same plaintext produce different envelopes (random IV)", () => {
    const aad = "aad";
    const pt = mod.asPlaintext("identical-input");
    const a = mod.encrypt(pt, aad);
    const b = mod.encrypt(pt, aad);
    expect(a).not.toBe(b);
    // Both still decrypt to the same plaintext.
    expect(String(mod.decrypt(a, aad))).toBe("identical-input");
    expect(String(mod.decrypt(b, aad))).toBe("identical-input");
  });
});

describe("encryption — AAD binding", () => {
  it("decrypt with a different AAD throws DecryptionFailureError (cross-user replay)", () => {
    const pt = mod.asPlaintext("token-A");
    const ct = mod.encrypt(pt, "user_prefs:tokens:v1:USER_A:jira.apiToken");
    expect(() =>
      mod.decrypt(ct, "user_prefs:tokens:v1:USER_B:jira.apiToken"),
    ).toThrow(mod.DecryptionFailureError);
  });

  it("decrypt with a different field path throws (intra-user cross-field swap)", () => {
    const pt = mod.asPlaintext("token-jira");
    const ct = mod.encrypt(pt, "user_prefs:tokens:v1:USER_A:jira.apiToken");
    expect(() =>
      mod.decrypt(ct, "user_prefs:tokens:v1:USER_A:github.token"),
    ).toThrow(mod.DecryptionFailureError);
  });
});

describe("encryption — key derivation", () => {
  it("HKDF-derived key is identical across module reloads with the same AUTH_SECRET", async () => {
    const aad = "aad";
    const pt = mod.asPlaintext("hello");
    const ct = mod.encrypt(pt, aad);

    // Reload module — fresh module instance, fresh cached key.
    const reloaded = await reload({ AUTH_SECRET: TEST_AUTH_SECRET });
    expect(String(reloaded.decrypt(ct as ReturnType<typeof reloaded.encrypt>, aad))).toBe("hello");
  });

  it("explicit TOKEN_ENCRYPTION_KEY takes precedence over AUTH_SECRET", async () => {
    const m1 = await reload({ AUTH_SECRET: TEST_AUTH_SECRET, TOKEN_ENCRYPTION_KEY: TEST_KEY_B64 });
    const ct = m1.encrypt(m1.asPlaintext("p"), "aad");
    // A reload that ALSO has TOKEN_ENCRYPTION_KEY can still decrypt.
    const m2 = await reload({ AUTH_SECRET: TEST_AUTH_SECRET, TOKEN_ENCRYPTION_KEY: TEST_KEY_B64 });
    expect(String(m2.decrypt(ct as ReturnType<typeof m2.encrypt>, "aad"))).toBe("p");
    // A reload with a DIFFERENT explicit key cannot decrypt.
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    const m3 = await reload({ AUTH_SECRET: TEST_AUTH_SECRET, TOKEN_ENCRYPTION_KEY: otherKey });
    expect(() => m3.decrypt(ct as ReturnType<typeof m3.encrypt>, "aad")).toThrow(
      m3.DecryptionFailureError,
    );
  });

  it("throws fast if neither TOKEN_ENCRYPTION_KEY nor AUTH_SECRET is set", async () => {
    const m = await reload({ AUTH_SECRET: undefined, TOKEN_ENCRYPTION_KEY: undefined });
    expect(() => m.encrypt(m.asPlaintext("x"), "aad")).toThrow(/Encryption key unavailable/);
  });

  it("throws if AUTH_SECRET is shorter than 32 chars", async () => {
    const m = await reload({ AUTH_SECRET: "tooshort", TOKEN_ENCRYPTION_KEY: undefined });
    expect(() => m.encrypt(m.asPlaintext("x"), "aad")).toThrow(/AUTH_SECRET is 8 chars/);
  });

  it("throws if TOKEN_ENCRYPTION_KEY is the wrong length", async () => {
    const shortKey = Buffer.alloc(16, 0).toString("base64"); // 16 bytes != 32
    const m = await reload({ AUTH_SECRET: TEST_AUTH_SECRET, TOKEN_ENCRYPTION_KEY: shortKey });
    expect(() => m.encrypt(m.asPlaintext("x"), "aad")).toThrow(/must decode to exactly 32 bytes/);
  });
});

describe("encryption — parseEnvelope", () => {
  it("returns wrong-prefix for plaintext", () => {
    const r = mod.parseEnvelope("just-a-plain-string");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("wrong-prefix");
  });

  it("returns unknown-version for enc:v2:...", () => {
    const r = mod.parseEnvelope("enc:v2:somebase64");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown-version");
  });

  it("returns short-iv when body is shorter than IV length", () => {
    // 5 bytes of base64 → 3-4 raw bytes → too short for IV
    const r = mod.parseEnvelope("enc:v1:" + Buffer.alloc(5, 0).toString("base64url"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("short-iv");
  });

  it("returns short-tag when body has IV but not enough for ciphertext+tag", () => {
    // 13 bytes → 12-byte IV + 1 byte = no ciphertext+tag room
    const r = mod.parseEnvelope("enc:v1:" + Buffer.alloc(13, 0).toString("base64url"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("short-tag");
  });

  it("returns ok with the three components for a valid envelope", () => {
    const ct = mod.encrypt(mod.asPlaintext("payload"), "aad");
    const r = mod.parseEnvelope(ct);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.iv.length).toBe(12);
      expect(r.tag.length).toBe(16);
      expect(r.ciphertext.length).toBeGreaterThan(0);
    }
  });
});

describe("encryption — isCiphertext", () => {
  it("returns true for an encrypted envelope, false otherwise", () => {
    const ct = mod.encrypt(mod.asPlaintext("x"), "aad");
    expect(mod.isCiphertext(ct)).toBe(true);
    expect(mod.isCiphertext("plain text")).toBe(false);
    expect(mod.isCiphertext("enc:v0:something")).toBe(false);
  });
});
