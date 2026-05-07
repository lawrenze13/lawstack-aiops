// Shared parser + renderer for the implementation handoff. Used by:
//
//   - server/jira/adf.ts implementCommentDoc        → cycle-1 Jira comment
//   - server/jira/qaFixComment.ts postQaFixComment   → cycle-N>1 Jira comment
//   - server/git/implementComplete.ts Step 1c        → GitHub PR description
//
// The parser reads the agent's `docs/implementation/<key>-implementation.md`
// and returns the four required sections plus any recognised optional
// sections. The renderer takes that parse + commits + prUrl and returns
// BOTH an ADF document (for Jira) and a markdown string (for `gh pr edit
// --body-file`) — byte-identical content, two formats.
//
// The strict heading allowlist is deliberate. A forgiving parser that
// accepted "## Tests" or "## Testing" would silently merge content into
// the wrong section if the agent's prompt drifts. Strict matching with
// graceful soft-fail (placeholder text when a section is missing) keeps
// the QA contract honest while surviving prompt drift.

import {
  type AdfBlockNode,
  type AdfDocument,
  bulletList,
  code,
  doc,
  heading,
  link,
  paragraph,
  rule,
  strong,
  text,
} from "./adf";

// ─── Parser ──────────────────────────────────────────────────────────────

/** Required + optional section names emitted by the renderer. */
export type ShipNoteSections = {
  /** Plain-text paragraph from the `## Summary` section. Empty when missing. */
  summary: string;
  /** One bullet per line of the `## User-visible changes` section. */
  userVisibleChanges: string[];
  /** `## Risk areas` bullets. */
  riskAreas: string[];
  /** `## Test Plan` bullets. */
  testPlan: string[];
  /** Recognised optional sections in source order (Files Touched,
   *  Out of scope, Migration notes, Rollback). Each preserved as
   *  raw markdown body for the renderer to reformat. */
  optional: Array<{ heading: string; body: string }>;
  /** True when ALL four required sections were present AND non-empty
   *  in the input. The renderer fills missing slots with placeholder
   *  text either way, but downstream callers (audit payload, ops
   *  dashboards) can use this flag to track agent prompt drift. */
  complete: boolean;
};

/**
 * Recognised section keys → match patterns. Strict allowlist:
 * unrecognised headings get dropped (we don't want random agent
 * thoughts ending up in the QA handoff). Forgiving on case + h2/h3
 * level. The patterns are tested against the heading TEXT (after
 * stripping the leading `#`s and whitespace).
 */
const REQUIRED_SECTIONS = {
  summary: /^summary$/i,
  userVisibleChanges: /^user[\s-]?visible(?:\s+changes)?$/i,
  riskAreas: /^risks?(?:\s+areas?)?$/i,
  testPlan: /^test\s*plan$/i,
} as const;

const OPTIONAL_SECTIONS: Array<{ key: string; pattern: RegExp; label: string }> = [
  { key: "files-touched", pattern: /^files\s+touched$/i, label: "Files Touched" },
  { key: "out-of-scope", pattern: /^out[\s-]?of[\s-]?scope$/i, label: "Out of scope" },
  { key: "migration", pattern: /^migration(?:\s+notes?)?$/i, label: "Migration notes" },
  { key: "rollback", pattern: /^rollback(?:\s+notes?)?$/i, label: "Rollback" },
];

/**
 * Parse the agent's implementation.md into the ship-note shape.
 *
 * Algorithm: split on heading lines (h2 OR h3). For each block,
 * match the heading against the required allowlist first, then the
 * optional allowlist. Bodies are stored as raw text; `bulletsFrom`
 * extracts bullets when needed (some sections like Summary stay
 * paragraph-shaped).
 */
export function extractShipNoteSections(markdown: string): ShipNoteSections {
  // Strip YAML frontmatter ("--- ... ---") if present.
  const stripped = markdown.replace(/^---\s*[\s\S]*?\n---\s*\n?/, "");

  type Block = { headingText: string; body: string };
  const blocks: Block[] = [];

  // Match h2 OR h3 headings; capture the heading text and slurp until
  // the next heading at the same level OR the next h1 (defensive).
  const headingRe = /^(#{2,3})\s+(.+?)\s*$/gm;
  const matches: Array<{ index: number; level: number; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(stripped)) !== null) {
    matches.push({
      index: m.index,
      level: m[1]!.length,
      text: m[2]!.trim(),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index;
    const next = matches[i + 1];
    const headingLineEnd = stripped.indexOf("\n", start);
    const bodyStart = headingLineEnd === -1 ? stripped.length : headingLineEnd + 1;
    const bodyEnd = next ? next.index : stripped.length;
    const body = stripped.slice(bodyStart, bodyEnd).trim();
    blocks.push({ headingText: matches[i]!.text, body });
  }

  let summary = "";
  let userVisibleChanges: string[] = [];
  let riskAreas: string[] = [];
  let testPlan: string[] = [];
  const optional: Array<{ heading: string; body: string }> = [];
  const seen = { summary: false, userVisible: false, risk: false, test: false };

  for (const block of blocks) {
    if (REQUIRED_SECTIONS.summary.test(block.headingText)) {
      summary = paragraphFrom(block.body);
      seen.summary = summary.length > 0;
      continue;
    }
    if (REQUIRED_SECTIONS.userVisibleChanges.test(block.headingText)) {
      userVisibleChanges = bulletsFrom(block.body);
      seen.userVisible = userVisibleChanges.length > 0;
      continue;
    }
    if (REQUIRED_SECTIONS.riskAreas.test(block.headingText)) {
      riskAreas = bulletsFrom(block.body);
      seen.risk = riskAreas.length > 0;
      continue;
    }
    if (REQUIRED_SECTIONS.testPlan.test(block.headingText)) {
      testPlan = bulletsFrom(block.body);
      seen.test = testPlan.length > 0;
      continue;
    }
    // Optional allowlist.
    const opt = OPTIONAL_SECTIONS.find((o) => o.pattern.test(block.headingText));
    if (opt) {
      optional.push({ heading: opt.label, body: block.body });
    }
    // Anything else is intentionally dropped.
  }

  return {
    summary,
    userVisibleChanges,
    riskAreas,
    testPlan,
    optional,
    complete: seen.summary && seen.userVisible && seen.risk && seen.test,
  };
}

/** Pull the first non-empty paragraph block as plain text. Strips
 *  trailing whitespace; stops at the next blank line. Returns "" if
 *  the body is empty or only contains list markers. */
function paragraphFrom(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  // First paragraph = up to the first blank line.
  const firstParaEnd = trimmed.indexOf("\n\n");
  const para = firstParaEnd === -1 ? trimmed : trimmed.slice(0, firstParaEnd);
  // If the first "paragraph" is actually a bullet list, return empty
  // (the agent put bullets where prose was expected).
  if (/^\s*[-*]\s/.test(para)) return "";
  return para.trim();
}

/** Extract bullet items from a markdown list block. Forgiving:
 *  accepts `- `, `* `, or `+ ` markers; preserves text after the
 *  marker; ignores indentation. Empty body → []. Body with no
 *  bullet markers → single-item list with the prose if non-empty
 *  (allows the agent to write a paragraph in a section that
 *  conceptually is a list — degraded but not lost). */
function bulletsFrom(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const bullets: string[] = [];
  const lines = trimmed.split("\n");
  let current: string | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*[-*+]\s+(.*)$/);
    if (match) {
      if (current !== null) bullets.push(current.trim());
      current = match[1]!;
    } else if (current !== null && line.trim().length > 0) {
      // Continuation of the current bullet (indented next line).
      current += " " + line.trim();
    } else if (current !== null && line.trim().length === 0) {
      // Blank line: end of current bullet.
      bullets.push(current.trim());
      current = null;
    }
  }
  if (current !== null) bullets.push(current.trim());

  if (bullets.length === 0) {
    // No bullet markers — fall back to treating the whole body as one
    // bullet so the content is preserved in the rendered output.
    return [trimmed];
  }
  return bullets.filter((b) => b.length > 0);
}

// ─── Renderer ────────────────────────────────────────────────────────────

export type ShipNoteInput = {
  jiraKey: string;
  title: string;
  prUrl: string;
  /** PR branch — included in the footer for cross-reference. */
  branch: string;
  commits: Array<{ sha: string; subject: string }>;
  /** Output of extractShipNoteSections on the latest implementation.md. */
  sections: ShipNoteSections;
  /** When > 1, swap heading from "Implementation complete" to
   *  "QA fix pushed — round N". Resolves brainstorm open question #1
   *  (QA-fix comment uses the same renderer). */
  cycleNumber?: number;
};

export type ShipNoteRendered = {
  /** ADF document for the Jira /comment endpoint. */
  adf: AdfDocument;
  /** Markdown string for `gh pr edit --body-file`. */
  markdown: string;
};

const PLACEHOLDER_PARA =
  "_section not provided by the agent — see the diff for details._";

/**
 * Render the ship-note for both Jira and GitHub. Both outputs carry
 * byte-identical content (same headings, same bullets, same footer);
 * only the format differs.
 */
export function buildImplementationShipNote(
  input: ShipNoteInput,
): ShipNoteRendered {
  const cycleN = input.cycleNumber && input.cycleNumber > 1 ? input.cycleNumber : 1;
  const headingText =
    cycleN > 1
      ? `QA fix pushed — round ${cycleN}`
      : "Implementation complete";

  return {
    adf: renderAdf(input, headingText),
    markdown: renderMarkdown(input, headingText),
  };
}

function renderAdf(input: ShipNoteInput, headingText: string): AdfDocument {
  const { sections, commits, prUrl, jiraKey, title } = input;

  const nodes: AdfBlockNode[] = [
    heading(2, headingText),
    paragraph(strong("Ticket: "), text(`${jiraKey} — ${title}`)),
    paragraph(strong("PR: "), link(prUrl, prUrl)),
    rule(),
  ];

  // Summary
  nodes.push(heading(3, "Summary"));
  if (sections.summary) {
    nodes.push(paragraph(sections.summary));
  } else {
    nodes.push(paragraph(text(PLACEHOLDER_PARA, [{ type: "em" }])));
  }

  // User-visible changes
  nodes.push(heading(3, "User-visible changes"));
  if (sections.userVisibleChanges.length > 0) {
    nodes.push(bulletList(sections.userVisibleChanges));
  } else {
    nodes.push(paragraph(text(PLACEHOLDER_PARA, [{ type: "em" }])));
  }

  // Risk areas
  nodes.push(heading(3, "Risk areas"));
  if (sections.riskAreas.length > 0) {
    nodes.push(bulletList(sections.riskAreas));
  } else {
    nodes.push(paragraph(text(PLACEHOLDER_PARA, [{ type: "em" }])));
  }

  // Test Plan
  nodes.push(heading(3, "Test Plan"));
  if (sections.testPlan.length > 0) {
    nodes.push(bulletList(sections.testPlan));
  } else {
    nodes.push(paragraph(text(PLACEHOLDER_PARA, [{ type: "em" }])));
  }

  // Optional sections in source order
  for (const opt of sections.optional) {
    nodes.push(heading(3, opt.heading));
    const optBullets = bulletsFrom(opt.body);
    if (optBullets.length > 0) {
      nodes.push(bulletList(optBullets));
    } else {
      nodes.push(paragraph(opt.body.trim() || PLACEHOLDER_PARA));
    }
  }

  // Commits
  if (commits.length > 0) {
    nodes.push(heading(3, "Commits"));
    nodes.push(
      bulletList(
        commits.map((c) => paragraph(code(c.sha), text(" "), text(c.subject))),
      ),
    );
  }

  // Footer
  nodes.push(rule());
  nodes.push(
    paragraph(
      strong("Plan: "),
      text(`docs/plans/${input.jiraKey}-plan.md`),
    ),
  );
  nodes.push(
    paragraph(text("Generated by LawStack/aiops.", [{ type: "em" }])),
  );

  return doc(nodes);
}

function renderMarkdown(input: ShipNoteInput, headingText: string): string {
  const { sections, commits, prUrl, jiraKey, title } = input;
  const lines: string[] = [];

  lines.push(`## ${headingText}`);
  lines.push("");
  lines.push(`**Ticket:** ${jiraKey} — ${title}`);
  lines.push(`**PR:** ${prUrl}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Summary
  lines.push("### Summary");
  lines.push("");
  lines.push(sections.summary || PLACEHOLDER_PARA);
  lines.push("");

  // User-visible changes
  lines.push("### User-visible changes");
  lines.push("");
  if (sections.userVisibleChanges.length > 0) {
    for (const b of sections.userVisibleChanges) lines.push(`- ${b}`);
  } else {
    lines.push(PLACEHOLDER_PARA);
  }
  lines.push("");

  // Risk areas
  lines.push("### Risk areas");
  lines.push("");
  if (sections.riskAreas.length > 0) {
    for (const b of sections.riskAreas) lines.push(`- ${b}`);
  } else {
    lines.push(PLACEHOLDER_PARA);
  }
  lines.push("");

  // Test Plan
  lines.push("### Test Plan");
  lines.push("");
  if (sections.testPlan.length > 0) {
    for (const b of sections.testPlan) lines.push(`- ${b}`);
  } else {
    lines.push(PLACEHOLDER_PARA);
  }
  lines.push("");

  // Optional sections in source order
  for (const opt of sections.optional) {
    lines.push(`### ${opt.heading}`);
    lines.push("");
    const optBullets = bulletsFrom(opt.body);
    if (optBullets.length > 0) {
      for (const b of optBullets) lines.push(`- ${b}`);
    } else {
      lines.push(opt.body.trim() || PLACEHOLDER_PARA);
    }
    lines.push("");
  }

  // Commits
  if (commits.length > 0) {
    lines.push("### Commits");
    lines.push("");
    for (const c of commits) lines.push(`- \`${c.sha}\` ${c.subject}`);
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("");
  lines.push(`**Plan:** \`docs/plans/${jiraKey}-plan.md\``);
  lines.push("");
  lines.push("_Generated by LawStack/aiops._");

  return lines.join("\n");
}
