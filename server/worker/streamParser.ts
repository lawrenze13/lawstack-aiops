// Normalises one line of `claude --output-format stream-json --verbose` output
// into a typed event the rest of the worker + UI can consume.
//
// Reference shapes from the Claude CLI:
//   { type: 'system', subtype: 'init', model, session_id, ... }
//   { type: 'assistant', message: { content: [{type:'text',text}|{type:'tool_use',name,input}] } }
//   { type: 'user', message: { content: [{type:'tool_result', tool_use_id, content, is_error}] } }
//   { type: 'stream_event', event: { type:'content_block_delta', delta:{type:'text_delta',text} } }
//   { type: 'result', total_cost_usd, num_turns, result, stop_reason, duration_ms }

export type ParsedEventType =
  | "system"
  | "assistant"
  | "user"
  | "stream_event"
  | "result"
  | "server"
  | "unknown";

export type ParsedEvent = {
  type: ParsedEventType;
  /** raw stream-json object with our normalisations applied */
  payload: Record<string, unknown>;
  /** convenience flags surfaced for UI rendering + cost meter */
  hint?: {
    text?: string;
    toolName?: string;
    toolInputSummary?: string;
    isToolError?: boolean;
    finalCostUsd?: number;
    finalTurns?: number;
    sessionId?: string;
    model?: string;
  };
};

export function parseStreamLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {
      type: "server",
      payload: { kind: "parse_error", line: trimmed.slice(0, 500) },
    };
  }

  const type = String(raw.type ?? "unknown");

  switch (type) {
    case "system":
      return parseSystem(raw);
    case "assistant":
      return parseAssistant(raw);
    case "user":
      return parseUser(raw);
    case "stream_event":
      // partial-message events. Cheap to ignore for v1; keep payload for
      // possible future "live token streaming" rendering.
      return { type: "stream_event", payload: raw };
    case "result":
      return parseResult(raw);
    default:
      return { type: "unknown", payload: raw };
  }
}

function parseSystem(raw: Record<string, unknown>): ParsedEvent {
  const subtype = raw.subtype as string | undefined;
  const hint: NonNullable<ParsedEvent["hint"]> = {};
  if (subtype === "init") {
    hint.sessionId = raw.session_id as string | undefined;
    hint.model = raw.model as string | undefined;
  }
  return { type: "system", payload: raw, hint };
}

function parseAssistant(raw: Record<string, unknown>): ParsedEvent {
  const msg = raw.message as { content?: unknown[] } | undefined;
  const content = Array.isArray(msg?.content) ? msg.content : [];

  const textParts: string[] = [];
  const tools: Array<{ name: string; input: unknown }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; name?: string; input?: unknown };
    if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
    if (b.type === "tool_use" && typeof b.name === "string") {
      tools.push({ name: b.name, input: b.input });
    }
  }

  const hint: NonNullable<ParsedEvent["hint"]> = {};
  if (textParts.length > 0) hint.text = textParts.join("\n").slice(0, 4000);
  if (tools.length > 0) {
    const t = tools[0]!;
    hint.toolName = t.name;
    hint.toolInputSummary = summariseToolInput(t.name, t.input);
  }
  return { type: "assistant", payload: raw, hint };
}

function parseUser(raw: Record<string, unknown>): ParsedEvent {
  const msg = raw.message as { content?: unknown[] } | undefined;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  let isToolError = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; is_error?: boolean };
    if (b.type === "tool_result" && b.is_error === true) isToolError = true;
  }
  return { type: "user", payload: raw, hint: { isToolError } };
}

function parseResult(raw: Record<string, unknown>): ParsedEvent {
  const cost = typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined;
  const turns = typeof raw.num_turns === "number" ? raw.num_turns : undefined;
  return {
    type: "result",
    payload: raw,
    hint: { finalCostUsd: cost, finalTurns: turns },
  };
}

function summariseToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  switch (name) {
    case "Read":
      return String(i.file_path ?? "");
    case "Write":
    case "Edit":
    case "MultiEdit":
      return String(i.file_path ?? "");
    case "Glob":
      return String(i.pattern ?? "");
    case "Grep":
      return String(i.pattern ?? "");
    case "Bash":
      return String(i.command ?? "").slice(0, 200);
    case "WebFetch":
      return String(i.url ?? "");
    case "Task":
      return String(i.description ?? "");
    case "TodoWrite": {
      const todos = i.todos as unknown[] | undefined;
      return `${todos?.length ?? 0} todo(s)`;
    }
    default:
      return "";
  }
}
