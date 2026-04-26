import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// In-memory runs row + audit capture.
const runRow = {
  id: "r1",
  status: "running" as string,
  killedReason: null as string | null,
  finishedAt: null as Date | null,
};
const auditCalls: Array<{ action: string; payload?: unknown }> = [];

vi.mock("@/server/db/client", () => {
  let pendingKey: string | null = null;
  let pendingSet: Partial<typeof runRow> | null = null;
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (cond: { __key?: string }) => {
      pendingKey = cond.__key ?? null;
      return chain;
    },
    set: (patch: Partial<typeof runRow>) => {
      pendingSet = patch;
      return chain;
    },
    run: () => {
      if (pendingSet && pendingKey === runRow.id) {
        Object.assign(runRow, pendingSet);
      }
      pendingKey = null;
      pendingSet = null;
      return undefined;
    },
    get: () => {
      if (pendingKey === runRow.id) return runRow;
      return undefined;
    },
    onConflictDoUpdate: () => chain,
    values: () => chain,
  };
  return { db: { update: () => chain, insert: () => chain, select: () => chain } };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return { ...actual, eq: (_col: unknown, val: string) => ({ __key: val }) };
});

vi.mock("@/server/db/schema", () => ({
  runs: { id: "id" },
}));

vi.mock("@/server/auth/audit", () => ({
  audit: (opts: { action: string; payload?: unknown }) => {
    auditCalls.push({ action: opts.action, payload: opts.payload });
  },
}));

let mod: typeof import("@/server/worker/credentialsFailure");
let jiraClientMod: typeof import("@/server/jira/client");

beforeEach(async () => {
  vi.resetModules();
  // Reset the in-memory row + audits.
  runRow.status = "running";
  runRow.killedReason = null;
  runRow.finishedAt = null;
  auditCalls.length = 0;
  mod = await import("@/server/worker/credentialsFailure");
  jiraClientMod = await import("@/server/jira/client");
});

describe("markRunCredentialsInvalid", () => {
  it("flips run.status='failed' with killed_reason='credentials_invalid:<service>'", () => {
    mod.markRunCredentialsInvalid({
      runId: "r1",
      taskId: "t1",
      service: "jira",
      err: new Error("nope"),
    });
    expect(runRow.status).toBe("failed");
    expect(runRow.killedReason).toBe("credentials_invalid:jira");
    expect(runRow.finishedAt).toBeInstanceOf(Date);
  });

  it("emits run.failed audit with redacted message", () => {
    mod.markRunCredentialsInvalid({
      runId: "r1",
      taskId: "t1",
      service: "github",
      err: new Error(
        "Authorization: Bearer ghp_AbcdEfghIjklMnopQrstUvwxYz12345678",
      ),
    });
    const failedAudit = auditCalls.find((a) => a.action === "run.failed");
    expect(failedAudit).toBeDefined();
    const payload = failedAudit!.payload as {
      service: string;
      reason: string;
      detail: string;
    };
    expect(payload.service).toBe("github");
    expect(payload.reason).toBe("credentials_invalid:github");
    expect(payload.detail).not.toContain("ghp_");
    expect(payload.detail).toContain("<redacted>");
  });

  it("works without a runId (no DB write, audit still fires)", () => {
    mod.markRunCredentialsInvalid({
      runId: null,
      taskId: "t-only",
      service: "jira",
      err: new Error("oops"),
    });
    expect(runRow.status).toBe("running"); // untouched
    const failedAudit = auditCalls.find((a) => a.action === "run.failed");
    expect(failedAudit).toBeDefined();
  });

  it("reasonFor produces template-literal-typed strings", () => {
    expect(mod.reasonFor("jira")).toBe("credentials_invalid:jira");
    expect(mod.reasonFor("github")).toBe("credentials_invalid:github");
  });

  it("isCredentialsInvalid recognises the typed error", () => {
    const err = new jiraClientMod.CredentialsInvalidError("jira", 401);
    expect(mod.isCredentialsInvalid(err)).toBe(true);
    expect(mod.isCredentialsInvalid(new Error("plain"))).toBe(false);
    expect(mod.isCredentialsInvalid("string")).toBe(false);
  });
});
