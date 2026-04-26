import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mocks for the lazy-required dependencies.
const mockReadUserPrefs = vi.fn();
const mockGetConfig = vi.fn();

vi.mock("@/server/lib/userPrefs", () => ({
  readUserPrefs: (id: string) => mockReadUserPrefs(id),
}));

vi.mock("@/server/lib/config", () => ({
  getConfig: (k: string) => mockGetConfig(k),
}));

let mod: typeof import("@/server/integrations/credentials");

beforeEach(async () => {
  vi.resetModules();
  mockReadUserPrefs.mockReset();
  mockGetConfig.mockReset();
  // Default: empty user prefs, empty instance config.
  mockReadUserPrefs.mockReturnValue({
    agentOverrides: {},
    notifications: {},
    credentials: {},
  });
  mockGetConfig.mockReturnValue(null);
  mod = await import("@/server/integrations/credentials");
});

describe("resolveCredentials — discriminated union", () => {
  it("returns source='missing' when no user creds AND no instance creds for jira", () => {
    const r = mod.resolveCredentials("U_a", "jira");
    expect(r.source).toBe("missing");
    if (r.source === "missing") {
      expect(r.value).toBeNull();
      expect(r.service).toBe("jira");
    }
  });

  it("returns source='missing' when no user creds AND no instance creds for github", () => {
    const r = mod.resolveCredentials("U_a", "github");
    expect(r.source).toBe("missing");
  });

  it("git always resolves — falls back to hardcoded default", () => {
    const r = mod.resolveCredentials("U_a", "git");
    // git's discriminated union has 'default' in addition to user/instance.
    expect(["user", "instance", "default"]).toContain(r.source);
    expect(r.value).toEqual({
      name: "lawstack-aiops",
      email: "ai-ops@multiportal.io",
    });
  });
});

describe("resolveCredentials — instance fallback", () => {
  beforeEach(() => {
    mockGetConfig.mockImplementation((k: string) => {
      if (k === "JIRA_BASE_URL") return "https://acme.atlassian.net";
      if (k === "JIRA_EMAIL") return "instance@acme.com";
      if (k === "JIRA_API_TOKEN") return "instance-token";
      if (k === "GITHUB_TOKEN") return "ghp_instance";
      return null;
    });
  });

  it("returns source='instance' for jira when only instance is configured", () => {
    const r = mod.resolveCredentials("U_a", "jira");
    expect(r.source).toBe("instance");
    if (r.source === "instance") {
      expect(r.value.baseUrl).toBe("https://acme.atlassian.net");
      expect(r.value.email).toBe("instance@acme.com");
      expect(String(r.value.apiToken)).toBe("instance-token");
    }
  });

  it("returns source='instance' for github when only instance is configured", () => {
    const r = mod.resolveCredentials("U_a", "github");
    expect(r.source).toBe("instance");
    if (r.source === "instance") {
      expect(String(r.value.token)).toBe("ghp_instance");
    }
  });

  it("returns source='missing' for jira when only some instance fields are set", () => {
    mockGetConfig.mockImplementation((k: string) => {
      if (k === "JIRA_BASE_URL") return "https://acme.atlassian.net";
      // Email + token missing — partial config doesn't satisfy.
      return null;
    });
    const r = mod.resolveCredentials("U_a", "jira");
    expect(r.source).toBe("missing");
  });
});

describe("resolveCredentials — user overlay wins", () => {
  beforeEach(() => {
    mockGetConfig.mockImplementation((k: string) => {
      if (k === "JIRA_BASE_URL") return "https://instance.atlassian.net";
      if (k === "JIRA_EMAIL") return "instance@x.com";
      if (k === "JIRA_API_TOKEN") return "instance-token";
      if (k === "GITHUB_TOKEN") return "ghp_instance";
      return null;
    });
  });

  it("returns source='user' for jira when user has overlay AND instance is set", () => {
    mockReadUserPrefs.mockReturnValue({
      agentOverrides: {},
      notifications: {},
      credentials: {
        jira: {
          baseUrl: "https://user.atlassian.net",
          email: "alice@x.com",
          apiToken: "alice-token",
        },
      },
    });
    const r = mod.resolveCredentials("U_a", "jira");
    expect(r.source).toBe("user");
    if (r.source === "user") {
      expect(r.value.baseUrl).toBe("https://user.atlassian.net");
      expect(r.value.email).toBe("alice@x.com");
      expect(String(r.value.apiToken)).toBe("alice-token");
    }
  });

  it("partial overlay — user has jira but not github — gives jira:user, github:instance", () => {
    mockReadUserPrefs.mockReturnValue({
      agentOverrides: {},
      notifications: {},
      credentials: {
        jira: {
          baseUrl: "https://user.atlassian.net",
          email: "alice@x.com",
          apiToken: "alice-token",
        },
      },
    });
    const all = mod.resolveAllCredentials("U_a");
    expect(all.jira.source).toBe("user");
    expect(all.github.source).toBe("instance");
  });

  it("user provides incomplete jira (missing apiToken) — falls through to instance", () => {
    mockReadUserPrefs.mockReturnValue({
      agentOverrides: {},
      notifications: {},
      credentials: {
        jira: {
          baseUrl: "https://user.atlassian.net",
          email: "alice@x.com",
          // apiToken missing
        },
      },
    });
    const r = mod.resolveCredentials("U_a", "jira");
    expect(r.source).toBe("instance");
  });
});

describe("resolveCredentials — null userId", () => {
  beforeEach(() => {
    mockGetConfig.mockImplementation((k: string) => {
      if (k === "JIRA_BASE_URL") return "https://x.atlassian.net";
      if (k === "JIRA_EMAIL") return "instance@x.com";
      if (k === "JIRA_API_TOKEN") return "tok";
      return null;
    });
  });

  it("system-driven calls (userId=null) skip user lookup and resolve instance", () => {
    const r = mod.resolveCredentials(null, "jira");
    expect(r.source).toBe("instance");
    expect(mockReadUserPrefs).not.toHaveBeenCalled();
  });

  it("system-driven git resolves to hardcoded default (no user, no instance setting)", () => {
    const r = mod.resolveCredentials(null, "git");
    expect(r.source).toBe("default");
    expect(r.value).toEqual({
      name: "lawstack-aiops",
      email: "ai-ops@multiportal.io",
    });
  });
});

describe("resolveAllCredentials", () => {
  it("returns all three resolved variants in one call", () => {
    mockGetConfig.mockImplementation((k: string) => {
      if (k === "JIRA_BASE_URL") return "https://x.atlassian.net";
      if (k === "JIRA_EMAIL") return "i@x.com";
      if (k === "JIRA_API_TOKEN") return "t";
      if (k === "GITHUB_TOKEN") return "g";
      return null;
    });
    mockReadUserPrefs.mockReturnValue({
      agentOverrides: {},
      notifications: {},
      credentials: {
        git: { name: "Alice", email: "alice@x.com" },
      },
    });
    const all = mod.resolveAllCredentials("U_a");
    expect(all.jira.source).toBe("instance");
    expect(all.github.source).toBe("instance");
    expect(all.git.source).toBe("user");
    if (all.git.source === "user") {
      expect(all.git.value).toEqual({ name: "Alice", email: "alice@x.com" });
    }
  });
});
