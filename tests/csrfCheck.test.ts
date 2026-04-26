import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetConfig = vi.fn();

vi.mock("@/server/lib/config", () => ({
  getConfig: (k: string) => mockGetConfig(k),
}));

let mod: typeof import("@/server/lib/csrfCheck");

const ORIG_NODE_ENV = process.env.NODE_ENV;

// process.env.NODE_ENV is a read-only string in Node's TS types; use
// Object.assign to mutate it from tests without TS narrowing it.
function setNodeEnv(v: string): void {
  Object.assign(process.env, { NODE_ENV: v });
}

beforeEach(async () => {
  vi.resetModules();
  mockGetConfig.mockReset();
  mod = await import("@/server/lib/csrfCheck");
});

afterEach(() => {
  setNodeEnv(ORIG_NODE_ENV ?? "test");
});

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://aiops.example.com/api/profile/credentials/test/jira", {
    method: "POST",
    headers,
  });
}

describe("checkOriginCsrf", () => {
  it("accepts when Origin matches AUTH_URL exactly", () => {
    mockGetConfig.mockImplementation((k: string) =>
      k === "AUTH_URL" ? "https://aiops.example.com" : undefined,
    );
    const r = mod.checkOriginCsrf(
      reqWith({ origin: "https://aiops.example.com" }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts when Origin matches AUTH_URL with trailing slash", () => {
    mockGetConfig.mockImplementation((k: string) =>
      k === "AUTH_URL" ? "https://aiops.example.com/" : undefined,
    );
    const r = mod.checkOriginCsrf(
      reqWith({ origin: "https://aiops.example.com" }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects when Origin does not match AUTH_URL", () => {
    mockGetConfig.mockImplementation((k: string) =>
      k === "AUTH_URL" ? "https://aiops.example.com" : undefined,
    );
    const r = mod.checkOriginCsrf(reqWith({ origin: "https://evil.example.com" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Origin/);
  });

  it("rejects when Origin is missing AND Referer is missing", () => {
    mockGetConfig.mockImplementation((k: string) =>
      k === "AUTH_URL" ? "https://aiops.example.com" : undefined,
    );
    const r = mod.checkOriginCsrf(reqWith({}));
    expect(r.ok).toBe(false);
  });

  it("falls back to Referer when Origin is missing", () => {
    mockGetConfig.mockImplementation((k: string) =>
      k === "AUTH_URL" ? "https://aiops.example.com" : undefined,
    );
    const r = mod.checkOriginCsrf(
      reqWith({ referer: "https://aiops.example.com/profile" }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects mismatching Referer when Origin is missing", () => {
    mockGetConfig.mockImplementation((k: string) =>
      k === "AUTH_URL" ? "https://aiops.example.com" : undefined,
    );
    const r = mod.checkOriginCsrf(
      reqWith({ referer: "https://evil.example.com/page" }),
    );
    expect(r.ok).toBe(false);
  });

  it("allows in dev when AUTH_URL is unset", () => {
    setNodeEnv("development");
    mockGetConfig.mockImplementation(() => undefined);
    const r = mod.checkOriginCsrf(reqWith({ origin: "https://anything" }));
    expect(r.ok).toBe(true);
  });

  it("denies in prod when AUTH_URL is unset", () => {
    setNodeEnv("production");
    mockGetConfig.mockImplementation(() => undefined);
    const r = mod.checkOriginCsrf(reqWith({ origin: "https://anything" }));
    expect(r.ok).toBe(false);
  });
});
