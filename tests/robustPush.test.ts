import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to intercept execFile BEFORE the module under test imports it.
// The helper uses promisify(execFile), so we mock node:child_process at
// the module boundary; promisify picks up our fake.
type ExecCall = { file: string; args: string[] };
const execCalls: ExecCall[] = [];
// Each entry: what the next exec call should do. Consumed in order.
// `null` means "succeed with empty stdout/stderr".
let execPlan: Array<null | { err?: Error; stdout?: string; stderr?: string }> = [];

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      execCalls.push({ file, args });
      const step = execPlan.shift() ?? null;
      if (step && step.err) cb(step.err, step.stdout ?? "", step.stderr ?? "");
      else cb(null, step?.stdout ?? "", step?.stderr ?? "");
    },
  };
});

// Import AFTER mocking so promisify wraps our fake.
const { robustPush, PushFailedError } = await import("@/server/git/push");

function nonFFError(): Error {
  return new Error(
    [
      "To github.com:example/repo.git",
      " ! [rejected]        MP-1-ai -> MP-1-ai (non-fast-forward)",
      "error: failed to push some refs",
    ].join("\n"),
  );
}

function noUpstreamError(): Error {
  return new Error(
    "fatal: The current branch MP-1-ai has no upstream branch.",
  );
}

beforeEach(() => {
  execCalls.length = 0;
  execPlan = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("robustPush", () => {
  it("plain push succeeds on the first try", async () => {
    execPlan = [null]; // git push → ok
    const res = await robustPush("/tmp/wt", "MP-1-ai");
    expect(res.ok).toBe(true);
    expect(res.rebased).toBe(false);
    expect(res.setUpstream).toBe(false);
    expect(execCalls).toEqual([{ file: "git", args: ["push"] }]);
  });

  it("missing upstream → retries with -u and succeeds", async () => {
    execPlan = [
      { err: noUpstreamError() }, // git push → fails
      null, // git push -u origin <branch> → ok
    ];
    const res = await robustPush("/tmp/wt", "MP-1-ai");
    expect(res.ok).toBe(true);
    expect(res.setUpstream).toBe(true);
    expect(res.rebased).toBe(false);
    expect(execCalls[0]).toEqual({ file: "git", args: ["push"] });
    expect(execCalls[1]).toEqual({
      file: "git",
      args: ["push", "-u", "origin", "MP-1-ai"],
    });
  });

  it("non-fast-forward → fetches, rebases, retries", async () => {
    execPlan = [
      { err: nonFFError() }, // git push → non-FF
      null, // git fetch origin <branch> → ok
      null, // git rebase origin/<branch> → ok
      null, // git push -u origin <branch> → ok
    ];
    const res = await robustPush("/tmp/wt", "MP-1-ai");
    expect(res.ok).toBe(true);
    expect(res.rebased).toBe(true);
    // The rebase call is prefixed with `-c user.email=… -c user.name=…`
    // so args[0] there is `-c`. Look for the operation word in each
    // call's args — robust against added config prefixes.
    const ops = execCalls.map((c) => {
      const op = c.args.find(
        (a) => a === "push" || a === "fetch" || a === "rebase",
      );
      return op;
    });
    expect(ops).toEqual(["push", "fetch", "rebase", "push"]);
  });

  it("rebase conflict → PushFailedError with stage=rebase", async () => {
    execPlan = [
      { err: nonFFError() }, // git push → non-FF
      null, // git fetch → ok
      { err: new Error("CONFLICT (content): Merge conflict in foo.php") },
    ];
    await expect(robustPush("/tmp/wt", "MP-1-ai")).rejects.toThrow(
      PushFailedError,
    );
    try {
      await robustPush("/tmp/wt", "MP-1-ai");
    } catch (e) {
      const err = e as InstanceType<typeof PushFailedError>;
      expect(err.stage).toBe("rebase");
    }
  });

  it("unknown push failure → bubbles as PushFailedError stage=push", async () => {
    execPlan = [
      { err: new Error("remote: permission denied") },
      { err: new Error("remote: permission denied") },
      // ^ second call from the -u retry path — also rejected
    ];
    await expect(robustPush("/tmp/wt", "MP-1-ai")).rejects.toThrow(
      PushFailedError,
    );
  });
});
