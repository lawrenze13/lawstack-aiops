import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetConfig = vi.fn();

vi.mock("@/server/lib/config", () => ({
  getConfig: (k: string) => mockGetConfig(k),
}));

let mod: typeof import("@/server/lib/userCredentialsTestActions");

beforeEach(async () => {
  vi.resetModules();
  mockGetConfig.mockReset();
  mockGetConfig.mockReturnValue(undefined);
  mod = await import("@/server/lib/userCredentialsTestActions");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock fetch — set up per test.
function mockFetch(impl: (input: RequestInfo | URL) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

describe("testJiraCreds", () => {
  it("returns malformed_input when fields are missing", async () => {
    const r = await mod.testJiraCreds({ baseUrl: "", email: "", apiToken: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed_input");
  });

  it("returns malformed_input for non-http baseUrl", async () => {
    const r = await mod.testJiraCreds({
      baseUrl: "ftp://acme.atlassian.net",
      email: "a@b.com",
      apiToken: "t",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed_input");
  });

  it("returns ok with extracted identity on 200", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          accountId: "acc-1",
          displayName: "Alice",
          emailAddress: "alice@x.com",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await mod.testJiraCreds({
      baseUrl: "https://acme.atlassian.net",
      email: "alice@x.com",
      apiToken: "atatt-XXXXX",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.details).toEqual({
        accountId: "acc-1",
        displayName: "Alice",
        emailAddress: "alice@x.com",
      });
    }
  });

  it("returns invalid_credentials on 401", async () => {
    mockFetch(async () => new Response("nope", { status: 401 }));
    const r = await mod.testJiraCreds({
      baseUrl: "https://acme.atlassian.net",
      email: "a@b.com",
      apiToken: "bad",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_credentials");
  });

  it("returns forbidden on 403", async () => {
    mockFetch(async () => new Response("nope", { status: 403 }));
    const r = await mod.testJiraCreds({
      baseUrl: "https://acme.atlassian.net",
      email: "a@b.com",
      apiToken: "scopeless",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
  });

  it("returns rate_limited on 429", async () => {
    mockFetch(async () => new Response("slow down", { status: 429 }));
    const r = await mod.testJiraCreds({
      baseUrl: "https://acme.atlassian.net",
      email: "a@b.com",
      apiToken: "ok",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rate_limited");
  });

  it("never echoes the upstream response body in the message", async () => {
    mockFetch(async () =>
      new Response("internal: token=ghp_LEAKED1234567890", { status: 401 }),
    );
    const r = await mod.testJiraCreds({
      baseUrl: "https://acme.atlassian.net",
      email: "a@b.com",
      apiToken: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain("ghp_");
      expect(r.message).not.toContain("LEAKED");
    }
  });
});

// ─── GitHub ───────────────────────────────────────────────────────────────────

describe("testGithubCreds", () => {
  it("returns malformed_input when token is missing", async () => {
    const r = await mod.testGithubCreds({ token: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed_input");
  });

  it("returns ok with login when /user returns 200 (no BASE_REPO)", async () => {
    mockGetConfig.mockReturnValue(undefined);
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "alice", id: 1 }), {
          status: 200,
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const r = await mod.testGithubCreds({ token: "ghp_xyz" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.details).toMatchObject({ login: "alice" });
      expect((r.details as { warning?: string }).warning).toBeDefined();
      expect((r.details as { repoAccess?: unknown }).repoAccess).toBeUndefined();
    }
  });

  it("returns invalid_credentials on /user 401", async () => {
    mockFetch(async () => new Response("bad", { status: 401 }));
    const r = await mod.testGithubCreds({ token: "ghp_bad" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_credentials");
  });

  it("returns forbidden on /user 403", async () => {
    mockFetch(async () => new Response("scope", { status: 403 }));
    const r = await mod.testGithubCreds({ token: "ghp_x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
  });
});
