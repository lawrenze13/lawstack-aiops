import { describe, expect, it } from "vitest";
import { parseStreamLine } from "@/server/worker/streamParser";

// Convenience: build an assistant event line with the given text blocks.
// Matches the real `claude --output-format stream-json` shape:
//   { type: 'assistant', message: { content: [ { type:'text', text }, ... ] } }
function assistantLine(...texts: string[]): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: texts.map((t) => ({ type: "text", text: t })),
    },
  });
}

describe("parseStreamLine — NEEDS_INPUT detection in assistant text", () => {
  it("catches a plain marker at start of text", () => {
    const line = assistantLine("NEEDS_INPUT: should I use mysql or postgres?");
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBe("should I use mysql or postgres?");
  });

  it("catches a marker in the middle of longer text", () => {
    const line = assistantLine(
      "Done with step 4. Now I need to check with you.\n\nNEEDS_INPUT: ok to run migrations in prod?",
    );
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBe("ok to run migrations in prod?");
  });

  it("captures a multi-paragraph question after the marker", () => {
    const text = [
      "I have two options in mind:",
      "",
      "NEEDS_INPUT:",
      "Should I (a) add a column to the users table, or (b) create a separate preferences table?",
      "",
      "Option (a) is simpler but ties preferences to user rows. Option (b) scales better.",
      "",
      "Reply with a or b.",
    ].join("\n");
    const ev = parseStreamLine(assistantLine(text));
    const q = ev?.hint?.needsInputQuestion;
    expect(q).toContain("Should I (a) add a column");
    expect(q).toContain("Reply with a or b.");
  });

  it("handles the **bold** wrapper Claude sometimes adds", () => {
    const line = assistantLine("**NEEDS_INPUT:** should I run the tests?");
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBe("should I run the tests?");
  });

  it("handles the __italic__ wrapper", () => {
    const line = assistantLine("__NEEDS_INPUT__: ok to commit?");
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBe("ok to commit?");
  });

  it("matches lowercase (case-insensitive) — Claude occasionally uses 'needs_input:'", () => {
    const line = assistantLine("needs_input: verify this assumption");
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBe("verify this assumption");
  });

  it("strips a trailing code fence if the agent wrapped the question", () => {
    const text = "NEEDS_INPUT: ok to proceed?\n```";
    const ev = parseStreamLine(assistantLine(text));
    expect(ev?.hint?.needsInputQuestion).toBe("ok to proceed?");
  });

  it("does NOT match when the marker is a substring of a word", () => {
    // The word "NEEDS_INPUTS:" (with trailing S) would never be a real
    // marker. Our regex requires a word boundary on the left.
    const line = assistantLine("The MARKET_NEEDS_INPUTS: is growing");
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBeUndefined();
  });

  it("returns undefined when no marker is present", () => {
    const line = assistantLine("Just working on this normally.");
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBeUndefined();
  });
});

describe("parseStreamLine — NEEDS_INPUT detection in final result", () => {
  it("catches a marker in the result text", () => {
    const line = JSON.stringify({
      type: "result",
      result: "NEEDS_INPUT: should I merge now?",
      total_cost_usd: 0.42,
      num_turns: 3,
    });
    const ev = parseStreamLine(line);
    expect(ev?.type).toBe("result");
    expect(ev?.hint?.needsInputQuestion).toBe("should I merge now?");
    expect(ev?.hint?.finalCostUsd).toBe(0.42);
    expect(ev?.hint?.finalTurns).toBe(3);
  });

  it("leaves needsInputQuestion undefined on a normal result", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Task complete — migration added.",
      total_cost_usd: 0.01,
      num_turns: 1,
    });
    const ev = parseStreamLine(line);
    expect(ev?.hint?.needsInputQuestion).toBeUndefined();
  });
});

describe("parseStreamLine — miscellaneous", () => {
  it("returns null for non-JSON lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("not json")).toBeNull();
  });

  it("surfaces parse errors as a server event", () => {
    const ev = parseStreamLine("{not valid json");
    expect(ev?.type).toBe("server");
    expect((ev?.payload as { kind?: string }).kind).toBe("parse_error");
  });

  it("captures session id from system init frame", () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "abc-123",
        model: "claude-opus-4-7",
      }),
    );
    expect(ev?.hint?.sessionId).toBe("abc-123");
    expect(ev?.hint?.model).toBe("claude-opus-4-7");
  });
});
