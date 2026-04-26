import { describe, expect, it } from "vitest";
import { redactSecrets, redactError } from "@/server/lib/redactSecrets";

// Test fixtures construct token-shaped strings via concatenation so the
// literal patterns never appear in the source file — this keeps GitHub's
// secret-scanning push protection from blocking commits even though the
// runtime values match our redaction regexes.
const FAKE_GHP = "ghp_" + "AbcdEfghIjklMnopQrstUvwxYz12345678";
const FAKE_FINE_PAT = "github_pat_" + "AAAA1111BBBB2222CCCC3333DDDD4444";
const FAKE_SLACK = "xox" + "b-" + "1234567890-ABCDEFGHIJKLMN";

describe("redactSecrets — token patterns", () => {
  it("redacts GitHub classic PATs (ghp_)", () => {
    const input = `auth failed with ${FAKE_GHP} token`;
    expect(redactSecrets(input)).toBe("auth failed with <redacted> token");
  });

  it("redacts fine-grained GitHub PATs", () => {
    expect(redactSecrets(FAKE_FINE_PAT)).toBe("<redacted>");
  });

  it("redacts Slack tokens", () => {
    const input = `Slack rejected ${FAKE_SLACK} as expired`;
    expect(redactSecrets(input)).toBe("Slack rejected <redacted> as expired");
  });

  it("redacts the base64 portion of Authorization: Basic headers", () => {
    const input = "Authorization: Basic dXNlckBleGFtcGxlLmNvbTpzZWNyZXQ=";
    expect(redactSecrets(input)).toBe("Authorization: Basic <redacted>");
  });

  it("redacts Authorization: Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(redactSecrets(input)).toBe("Authorization: Bearer <redacted>");
  });

  it("redacts standalone basic-auth-shaped base64 (email:token pair)", () => {
    // base64("alice@example.com:secret-api-token-123456") — long enough
    // to trigger the heuristic + decodes to a printable string with `:`.
    const pair = "alice@example.com:secret-api-token-1234567";
    const b64 = Buffer.from(pair).toString("base64");
    expect(redactSecrets(`raw token: ${b64}`)).toBe("raw token: <redacted>");
  });

  it("leaves non-secret strings alone", () => {
    const input = "lookup failed for issue ABC-123 in https://example.com";
    expect(redactSecrets(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = redactSecrets(FAKE_GHP);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it("redactError handles Error objects", () => {
    const err = new Error(`Bad token: ${FAKE_GHP}`);
    expect(redactError(err)).toBe("Bad token: <redacted>");
  });

  it("redactError handles non-Error throws", () => {
    expect(redactError(FAKE_GHP)).toBe("<redacted>");
  });
});
