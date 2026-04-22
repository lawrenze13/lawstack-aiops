// Source of truth for the agent library at boot. Each agent is a thin wrapper
// over `claude -p` with a different prompt template + skill hint + model.
//
// On first DB import, entries here are upserted into the `agent_config` cache
// table with a config_hash. Each `runs` row pins the full snapshot at start
// time so historical runs remain inspectable after registry edits.

import { createHash } from "node:crypto";

export type Lane = "brainstorm" | "plan" | "review" | "pr" | "implement";

export type PermissionMode = "acceptEdits" | "bypassPermissions";

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
   * Permission mode passed to `claude --permission-mode`:
   *  - `acceptEdits` (default): auto-accept file edits, prompt for Bash.
   *    Planning agents only write markdown files, so this is enough.
   *  - `bypassPermissions`: auto-accept everything including Bash.
   *    Required for `ce:work` which runs git + build/test commands
   *    and would otherwise stall on every permission prompt.
   * Bounded by the subprocess cwd (the worktree) + minimised env so
   * the agent can't reach outside.
   */
  permissionMode?: PermissionMode;
  /**
   * Per-agent cost-cap overrides. Implementation agents (`ce:work`) run
   * longer than planning agents, so they get higher caps. Falls through
   * to the global defaults (5 / 15) if unset.
   */
  costWarnUsd?: number;
  costKillUsd?: number;
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
  /**
   * How many prior reviews exist on this task (before the current run).
   * Zero on first review, 1 on the second, etc. Review prompt tightens
   * the "what blocks READY" bar as this climbs — prevents infinite
   * AMEND loops where the reviewer keeps finding new-but-P2 issues.
   */
  priorReviewCount?: number;
  /**
   * Interactive mode: when true (for ce:work), the prompt instructs the
   * agent to pause via NEEDS_INPUT before running any Bash command and
   * wait for human approval. See workPrompt.
   */
  interactive?: boolean;
  /**
   * Jira comments on the ticket (oldest-first, plain-text). Bug reports
   * and clarification threads often live here, not in the description,
   * so we inject them into the prompt alongside the description for
   * Brainstorm / Plan / Review. Skipped for ce:work to keep its prompt
   * short — by the time we implement, the Plan has already absorbed
   * anything relevant from the comments.
   */
  jiraComments?: Array<{ author: string; created: string; body: string }>;
};

/**
 * Render the task's Jira comments as a markdown section. Empty string
 * when there are no comments — the agent prompts check for truthiness.
 */
function renderJiraComments(
  comments: PromptContext["jiraComments"],
  maxChars = 6000,
): string {
  if (!comments || comments.length === 0) return "";
  const rendered = comments
    .map((c) => `**${c.author}** · ${c.created || "unknown date"}\n${c.body}`)
    .join("\n\n---\n\n");
  // Budget cap so a chatty ticket doesn't blow out the prompt. Newest
  // comments kept (they're usually most relevant); tail trimmed.
  const trimmed =
    rendered.length > maxChars
      ? rendered.slice(-maxChars) + "\n\n_[earlier comments truncated]_"
      : rendered;
  return `\n\nComments on the Jira ticket (oldest → newest):\n${trimmed}`;
}

const brainstormPrompt = (ctx: PromptContext): string => `You are analyzing Jira ticket ${ctx.jiraKey} in this codebase and producing a brainstorm document.

Use the compound-engineering:ce:brainstorm approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Description:
${ctx.description || "(no description provided)"}${renderJiraComments(ctx.jiraComments)}

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
${ctx.description || "(no description provided)"}${renderJiraComments(ctx.jiraComments)}${commitsBlock}

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

// Amendment prompt: used when the user clicks "Amend Plan" after a Review
// returned AMEND/REWRITE. Produces a revised plan that explicitly addresses
// every finding in the Review's Incorrect-or-stale + Missing sections.
export function buildAmendPlanPrompt(ctx: PromptContext): string {
  const plan = ctx.priorArtifacts?.find((a) => a.kind === "plan")?.markdown ?? "";
  const review = ctx.priorArtifacts?.find((a) => a.kind === "review")?.markdown ?? "";
  const brainstorm = ctx.priorArtifacts?.find((a) => a.kind === "brainstorm")?.markdown ?? "";
  const commitsBlock = ctx.recentCommits
    ? `

Recent commits on main (freshness context):
\`\`\`
${ctx.recentCommits}
\`\`\``
    : "";
  return `You are amending an existing implementation plan for Jira ticket ${ctx.jiraKey} based on a Review that flagged issues.

Use the compound-engineering:ce:plan approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Description:
${ctx.description || "(no description provided)"}${renderJiraComments(ctx.jiraComments)}

Brainstorm (background):
${brainstorm || "(no brainstorm available)"}

Previous Plan (to revise):
${plan || "(no prior plan available — produce one from scratch)"}

Review findings (ADDRESS EVERY ITEM):
${review || "(no review available — treat as a fresh Plan run)"}${commitsBlock}

Your job: produce a REVISED plan that fixes every concrete finding in the Review.
- Every item in the Review's "Incorrect or stale" section must be corrected.
- Every item in "Missing" must be addressed somewhere in the plan (even
  briefly — at minimum acknowledge the edge case and call out where it's
  handled).
- Preserve the parts listed in "Verified" unless the Missing/Incorrect
  findings require changing them.
- Where the Review cited file:line references, re-read those files before
  writing your correction to make sure your fix is grounded.

Produce ONE file:

  docs/plans/${ctx.jiraKey}-plan.md

  - Overwrite the existing plan with the revised version.
  - YAML frontmatter: ticket, date, status: draft
  - Keep it concise and actionable.
  - Include a short "Amendments from review" section at the end listing
    what you changed in response to the Review.

Rules:
- Do NOT modify any source files.
- Read real files with Read/Grep/Glob to verify claims.
- Cite real file paths.
`;
}

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

  const iteration = ctx.priorReviewCount ?? 0;
  const iterationGuidance =
    iteration === 0
      ? "This is the first review pass."
      : iteration === 1
        ? "This is the second review — the plan has already been amended once. Focus on blockers; acknowledge that P1/P2 items from prior reviews have been addressed or documented."
        : `This is review #${iteration + 1} — the plan has been amended ${iteration} times already. The team is iterating toward ship, not toward perfection. Only flag P0 blockers. If you find yourself surfacing new P2s that weren't caught before, the plan is likely READY.`;

  // Plan-validation prompt: the agent's job is to check the plan against
  // reality, not survey the codebase from scratch. Catches "the plan refers
  // to a file that doesn't exist" and "the plan assumes X but the code
  // actually does Y" — the kinds of mistakes that cause wasted
  // implementation time downstream.
  //
  // Pragmatic shipping: Review's verdict bar is "no P0 blockers", NOT "no
  // imaginable improvement." P1/P2 findings are notes for the human
  // reviewer in code review, not reasons to regenerate the plan.
  return `You are validating an implementation plan for Jira ticket ${ctx.jiraKey} against the real codebase.

Use the compound-engineering:ce:review approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Description:
${ctx.description || "(no description provided)"}${renderJiraComments(ctx.jiraComments)}

Brainstorm:
${brainstorm || "(no brainstorm artifact — noted; your review can proceed without it)"}

Plan to validate:
${plan || "(no plan artifact was produced — FLAG THIS as the primary issue; a review without a plan is nearly useless)"}${commitsBlock}

**Review iteration:** ${iterationGuidance}

Your job: verify the Plan's **concrete claims** against the real code.
Focus on correctness, NOT completeness. A plan that is directionally right
with a few minor gaps should be READY; a human reviewer will catch
details in PR review. You are not responsible for perfecting the plan.

**Severity definitions — use these strictly**:
- **P0 (blocking)** — the plan WILL BREAK on implementation: a cited file
  doesn't exist, a function signature is wrong, an assumption about
  current behavior is flat wrong. Only P0s trigger AMEND/REWRITE.
- **P1 (nice to have)** — the plan could be improved but won't break.
  Mention in the review; do NOT use for verdict decision.
- **P2 (tangential)** — code you'd touch if you were writing this
  yourself, but the plan's scope is already sufficient. Mention briefly
  at most; do NOT block on these.

Produce ONE file:

  docs/reviews/${ctx.jiraKey}-review.md

with YAML frontmatter (ticket, date, status: draft) and these sections:

## Verified
List of plan claims that check out, with \`file:line\` references where
the code matches. Short bullets. Be generous — if the plan is directionally
right, list what works.

## Incorrect or stale
Only P0 items go here. For each:
  - What the plan says: "..."
  - What the code actually says (with file:line): "..."
  - Proposed correction: "..."

## Missing
Only P0 items that the plan must address. Edge cases or additional files
go into Notes below, not here.

## Notes (optional)
Non-blocking P1/P2 observations. One bullet each, keep it short.
These do NOT affect the verdict.

## Verdict
Close the file with exactly one of:
  - **READY** — plan is directionally correct with no P0 blockers.
    P1/P2 notes are acceptable; human review will handle details.
    Default to READY unless there is a real P0.
  - **AMEND** — the plan has one or more P0 blockers that need fixing
    before implementation.
  - **REWRITE** — the plan fundamentally misunderstands the code or
    requirements. Rare.

**Default posture**: if you find yourself debating whether something is
P0 or P1, it's P1. Ship unless a real blocker exists.

Rules:
- Do NOT modify any source files.
- Read real files with Read/Grep/Glob; do not rely on the plan's summaries.
- Cite real file:line paths in every P0 claim.
- If the Plan is missing, produce a review with verdict REWRITE and
  explain what a plan would need to cover.
`;
};

const workPrompt = (ctx: PromptContext): string => {
  const plan = ctx.priorArtifacts?.find((a) => a.kind === "plan")?.markdown ?? "";
  const brainstorm = ctx.priorArtifacts?.find((a) => a.kind === "brainstorm")?.markdown ?? "";
  const review = ctx.priorArtifacts?.find((a) => a.kind === "review")?.markdown ?? "";
  const commitsBlock = ctx.recentCommits
    ? `

Recent commits on main:
\`\`\`
${ctx.recentCommits}
\`\`\``
    : "";

  const interactiveBlock = ctx.interactive
    ? `

## ⚠ INTERACTIVE MODE — confirm every Bash command

You are running in **interactive mode**. Before executing ANY shell
command via the Bash tool (including git, npm, tests, builds, anything),
you MUST pause and ask the user for approval via NEEDS_INPUT. Do not
run the command first and ask forgiveness.

Format your permission request like this (literal — do not wrap in code block):

    NEEDS_INPUT:
    Permission to run: \`<the exact command>\`

    <one short line of why this is the right next step>

    Reply **yes** to run it, **no** to skip, or suggest an alternative.

After the user replies **yes**, run the command. If they reply **no** or
with an alternative, adjust and proceed. You may batch related commands
in one request (e.g. "git add X && git commit -m ..." as one unit) but
do NOT sneak commands in without asking.

Reads, greps, globs, and file Edits do NOT need permission — those are
auto-allowed for exploration and code modification. Only shell commands
need confirmation.

This mode trades speed for visibility. The user wants to see every
action before it happens.`
    : "";

  return `You are implementing Jira ticket ${ctx.jiraKey} against the repository in this worktree.

Use the compound-engineering:ce:work approach.

Ticket: ${ctx.jiraKey}
Title: ${ctx.title}

Description:
${ctx.description || "(no description provided)"}

Brainstorm (background):
${brainstorm || "(no brainstorm artifact)"}

Plan to implement (PRIMARY INPUT):
${plan || "(no plan artifact — STOP and emit NEEDS_INPUT asking for a plan first)"}

Review notes (validated against the codebase):
${review || "(no review artifact — proceed but flag anything the plan doesn't cover)"}${commitsBlock}${interactiveBlock}

## Your job

Execute the Plan. Write real code, run tests where applicable. Leave the
changes uncommitted in the working tree — the server commits and pushes
in a single follow-up step after you finish.

## ⚠ Do NOT commit or push

Do NOT run \`git add\`, \`git commit\`, \`git checkout -b\`, \`git push\`,
\`git stash\`, \`git reset\`, \`git rebase\`, or any other state-changing
git command. The post-implement finalisation on the server side:
  - Stages all changes you left in the working tree (\`git add -A\`).
  - Builds one commit with a message referencing this Jira ticket.
  - Pushes to \`${ctx.jiraKey}-ai\` so the draft PR updates.

You may freely run read-only git commands (\`git status\`, \`git diff\`,
\`git log\`, \`git blame\`, \`git ls-files\`) to understand the repo.

Why: a single, clean commit by the server is easier for the human PR
reviewer than a scattered string of intermediate commits.

## When to pause and ask${ctx.interactive ? " (beyond permission requests)" : ""}

If you hit a real decision point the Plan doesn't cover, STOP and ask the
user. End your turn with exactly this marker on its own line:

\`\`\`
NEEDS_INPUT:
<your question, as a clear markdown paragraph. Max 3-4 lines.
Propose 2-3 concrete options where possible so the user can just pick one.>
\`\`\`

Do NOT wrap NEEDS_INPUT in a code block. The server parses the marker
and shows your question to the user as a banner; they'll reply via
chat and your session resumes.

Triggers for NEEDS_INPUT:
- Missing credentials or config you can't safely guess.
- Design decisions with real tradeoffs (backwards compatibility, naming,
  behavior on edge cases the plan doesn't cover).
- Scope calls — "should I also fix X since I'm in here?"
- Ambiguity in the requirements you can't resolve from the code.

Do NOT use NEEDS_INPUT for:
- Simple lookups (grep the code, don't ask).
- Cosmetic choices (just pick one).
- Things already answered in the Plan or Review.

## Finishing

When the implementation is complete:
1. Run \`git status\` to verify your changes are present in the working
   tree (uncommitted is correct — server will commit them).
2. Write \`docs/implementation/${ctx.jiraKey}-implementation.md\` with:
   - One short paragraph of what changed.
   - Bullet list of files touched and why (since there are no commits
     for the reviewer to scan, the file-by-file summary is important).
   - "Manual verification" section: what the human should check before
     undrafting the PR.
3. Your final message should summarise the work briefly. The server
   will automatically:
     - stage everything, commit with a single message, push
     - post a Jira comment with the file list + summary
     - transition the Jira ticket to "Code Review"

## Rules

- Stay inside this worktree; don't touch anything outside it.
- Follow existing code style (look at surrounding files).
- Do NOT rewrite unrelated code.
- Do NOT skip commit hooks or tests; investigate failures.
- When in doubt, NEEDS_INPUT is the safe path.
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
  "ce:work": {
    id: "ce:work",
    name: "CE Implement",
    lanes: ["implement"],
    skillHint: "compound-engineering:ce:work",
    // Opus for implementation — cheaper-but-dumber sonnet will thrash on
    // real code. Implementation is where model quality matters most.
    model: "claude-opus-4-7",
    maxTurns: 120,
    // Bypass permission prompts — ce:work needs `git add/commit/push`
    // plus likely test/build commands. Bounded to the worktree + minimised
    // env in spawnAgent.
    permissionMode: "bypassPermissions",
    // Implementation is expensive. Raise caps so a real ticket fits in
    // one run without tripping the generic $5/$15.
    costWarnUsd: 10,
    costKillUsd: 30,
    buildPrompt: workPrompt,
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
    case "implement":
      return "ce:work";
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
