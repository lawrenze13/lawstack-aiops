// Source of truth for the agent library at boot. Each agent is a thin wrapper
// over `claude -p` with a different prompt template + skill hint + model.
//
// On first DB import, entries here are upserted into the `agent_config` cache
// table with a config_hash. Each `runs` row pins the full snapshot at start
// time so historical runs remain inspectable after registry edits.

import { createHash } from "node:crypto";

export type Lane = "brainstorm" | "plan" | "review" | "pr";

export type AgentConfig = {
  id: string;
  name: string;
  lanes: readonly Lane[];
  /** Hint for Claude to invoke a particular skill (e.g. ce:brainstorm). */
  skillHint: string | null;
  /** Model id passed to `claude --model`. */
  model: string;
  /** Hard cap on Claude turns to keep cost bounded. */
  maxTurns: number;
  /**
   * Build the prompt string Claude receives. Variables come from the run
   * context: jiraKey, title, description, plus optional priorArtifacts.
   */
  buildPrompt: (ctx: PromptContext) => string;
};

export type PromptContext = {
  jiraKey: string;
  title: string;
  description: string;
  /** Markdown bodies of upstream artifacts (e.g. brainstorm.md fed into Plan). */
  priorArtifacts?: { kind: string; markdown: string }[];
  /**
   * Output of `git log -20 --oneline origin/main` — injected into Plan and
   * Review prompts so the agent has freshness context about the codebase.
   */
  recentCommits?: string;
};

const brainstormPrompt = (ctx: PromptContext): string => `You are analyzing Jira ticket ${ctx.jiraKey} in this codebase and producing a brainstorm document.

Use the compound-engineering:ce:brainstorm approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Description:
${ctx.description || "(no description provided)"}

Produce one file:

  docs/brainstorms/${ctx.jiraKey}-brainstorm.md

  - Explore requirements, edge cases, approaches, trade-offs
  - Reference real files and patterns from this repo where applicable
  - YAML frontmatter with: ticket, date, status: draft

Rules:
- Do NOT modify any other files
- Keep the file concise, actionable, and grounded in the actual codebase
- Before writing, briefly scan relevant parts of the repo to ground your suggestions
`;

const planPrompt = (ctx: PromptContext): string => {
  const brainstorm = ctx.priorArtifacts?.find((a) => a.kind === "brainstorm")?.markdown ?? "";
  const commitsBlock = ctx.recentCommits
    ? `

Recent commits on main (for freshness context; verify assumptions about current code rather than relying on these):
\`\`\`
${ctx.recentCommits}
\`\`\``
    : "";
  return `You are producing an implementation plan for Jira ticket ${ctx.jiraKey} based on the brainstorm below.

Use the compound-engineering:ce:plan approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Brainstorm:
${brainstorm || "(no brainstorm provided — produce a plan grounded in the description below)"}

Description:
${ctx.description || "(no description provided)"}${commitsBlock}

Produce one file:

  docs/plans/${ctx.jiraKey}-plan.md

  - Concrete implementation plan informed by the brainstorm
  - Reference real file paths in this repo
  - YAML frontmatter with: ticket, date, status: draft

Rules:
- Do NOT modify any other files
- Keep the file concise, actionable, and grounded in the actual codebase
`;
};

const reviewPrompt = (ctx: PromptContext): string => {
  const brainstorm = ctx.priorArtifacts?.find((a) => a.kind === "brainstorm")?.markdown ?? "";
  const plan = ctx.priorArtifacts?.find((a) => a.kind === "plan")?.markdown ?? "";
  const commitsBlock = ctx.recentCommits
    ? `

Recent commits on main (freshness context):
\`\`\`
${ctx.recentCommits}
\`\`\``
    : "";

  // Plan-validation prompt: the agent's job is to check the plan against
  // reality, not survey the codebase from scratch. Catches "the plan refers
  // to a file that doesn't exist" and "the plan assumes X but the code
  // actually does Y" — the kinds of mistakes that cause wasted
  // implementation time downstream.
  return `You are validating an implementation plan for Jira ticket ${ctx.jiraKey} against the real codebase.

Use the compound-engineering:ce:review approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Description:
${ctx.description || "(no description provided)"}

Brainstorm:
${brainstorm || "(no brainstorm artifact — noted; your review can proceed without it)"}

Plan to validate:
${plan || "(no plan artifact was produced — FLAG THIS as the primary issue; a review without a plan is nearly useless)"}${commitsBlock}

Your job: for EACH concrete claim in the Plan (file paths, function names,
types, assumptions about current behavior, proposed changes), verify it by
reading the real code in this worktree. Be aggressive — don't assume the
plan is right.

Produce ONE file:

  docs/reviews/${ctx.jiraKey}-review.md

with YAML frontmatter (ticket, date, status: draft) and these sections:

## Verified
List of plan claims that check out, with \`file:line\` references where
the code matches. Short bullets.

## Incorrect or stale
Claims that don't match the current code. Be specific:
  - What the plan says: "..."
  - What the code actually says (with file:line): "..."
  - Proposed correction: "..."

## Missing
Edge cases, concurrency issues, error paths, or API surface points the
plan didn't address. What would break on implementation?

## Verdict
Close the file with exactly one of:
  - **READY** — plan is correct and complete, ship it.
  - **AMEND** — plan is mostly right but has specific fixable issues
    (list them as 'P0' / 'P1' in the Incorrect-or-stale section).
  - **REWRITE** — plan fundamentally misunderstands the code or
    requirements; regenerate.

Rules:
- Do NOT modify any source files.
- Read real files with Read/Grep/Glob; do not rely on the plan's summaries.
- Cite real file:line paths in every claim.
- If the Plan is missing, produce a review with verdict REWRITE and
  explain what a plan would need to cover.
`;
};

export const AGENTS = {
  "ce:brainstorm": {
    id: "ce:brainstorm",
    name: "CE Brainstorm",
    lanes: ["brainstorm"],
    skillHint: "compound-engineering:ce:brainstorm",
    model: "claude-sonnet-4-6",
    maxTurns: 30,
    buildPrompt: brainstormPrompt,
  },
  "ce:plan": {
    id: "ce:plan",
    name: "CE Plan",
    lanes: ["plan"],
    skillHint: "compound-engineering:ce:plan",
    model: "claude-sonnet-4-6",
    maxTurns: 40,
    buildPrompt: planPrompt,
  },
  "ce:review": {
    id: "ce:review",
    name: "CE Review",
    lanes: ["review", "plan"],
    skillHint: "compound-engineering:ce:review",
    model: "claude-sonnet-4-6",
    maxTurns: 30,
    buildPrompt: reviewPrompt,
  },
} as const satisfies Record<string, AgentConfig>;

export type AgentId = keyof typeof AGENTS;

export function getAgent(id: string): AgentConfig | undefined {
  return (AGENTS as Record<string, AgentConfig>)[id];
}

export function defaultAgentForLane(lane: Lane): AgentId | undefined {
  switch (lane) {
    case "brainstorm":
      return "ce:brainstorm";
    case "plan":
      return "ce:plan";
    case "review":
      return "ce:review";
    case "pr":
      return undefined; // PR is not agent-driven; user clicks Approve & PR
  }
}

/** Stable hash of a config so the cache table can detect drift. */
export function hashAgentConfig(a: AgentConfig): string {
  const payload = JSON.stringify({
    id: a.id,
    name: a.name,
    lanes: a.lanes,
    skillHint: a.skillHint,
    model: a.model,
    maxTurns: a.maxTurns,
    // Hash the prompt fn's *source* so template changes invalidate the cache.
    promptSrc: a.buildPrompt.toString(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Snapshot the agent config into the JSON column on a run row. */
export function snapshotAgent(a: AgentConfig): string {
  return JSON.stringify({
    id: a.id,
    name: a.name,
    skillHint: a.skillHint,
    model: a.model,
    maxTurns: a.maxTurns,
    configHash: hashAgentConfig(a),
  });
}
