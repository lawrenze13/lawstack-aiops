// Minimal Atlassian Document Format helpers. Jira's /comment endpoint and
// most multi-line fields require ADF, not plain text or markdown.
// Spec: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

export type AdfMark =
  | { type: "strong" }
  | { type: "em" }
  | { type: "code" }
  | { type: "link"; attrs: { href: string } };

export type AdfText = { type: "text"; text: string; marks?: AdfMark[] };
export type AdfHardBreak = { type: "hardBreak" };
export type AdfInline = AdfText | AdfHardBreak;

export type AdfParagraph = { type: "paragraph"; content: AdfInline[] };
export type AdfHeading = {
  type: "heading";
  attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 };
  content: AdfInline[];
};
export type AdfCodeBlock = {
  type: "codeBlock";
  attrs?: { language?: string };
  content: AdfText[];
};
export type AdfListItem = {
  type: "listItem";
  content: Array<AdfParagraph | AdfBulletList | AdfOrderedList>;
};
export type AdfBulletList = { type: "bulletList"; content: AdfListItem[] };
export type AdfOrderedList = { type: "orderedList"; content: AdfListItem[] };
export type AdfRule = { type: "rule" };
export type AdfPanel = {
  type: "panel";
  attrs: { panelType: "info" | "note" | "success" | "warning" | "error" };
  content: AdfParagraph[];
};

export type AdfBlockNode =
  | AdfParagraph
  | AdfHeading
  | AdfCodeBlock
  | AdfBulletList
  | AdfOrderedList
  | AdfRule
  | AdfPanel;

export type AdfDocument = {
  type: "doc";
  version: 1;
  content: AdfBlockNode[];
};

// ─── Inline helpers ────────────────────────────────────────────────────────

export function text(t: string, marks?: AdfMark[]): AdfText {
  const node: AdfText = { type: "text", text: t };
  if (marks && marks.length > 0) node.marks = marks;
  return node;
}

export function strong(t: string): AdfText {
  return text(t, [{ type: "strong" }]);
}

export function link(t: string, href: string): AdfText {
  return text(t, [{ type: "link", attrs: { href } }]);
}

export function code(t: string): AdfText {
  return text(t, [{ type: "code" }]);
}

// ─── Block helpers ─────────────────────────────────────────────────────────

export function paragraph(...inlines: Array<AdfInline | string>): AdfParagraph {
  return {
    type: "paragraph",
    content: inlines.map((i) => (typeof i === "string" ? text(i) : i)),
  };
}

export function heading(level: 1 | 2 | 3 | 4 | 5 | 6, ...inlines: Array<AdfInline | string>): AdfHeading {
  return {
    type: "heading",
    attrs: { level },
    content: inlines.map((i) => (typeof i === "string" ? text(i) : i)),
  };
}

export function codeBlock(t: string, language?: string): AdfCodeBlock {
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    content: [{ type: "text", text: t }],
  };
}

export function bulletList(items: Array<AdfParagraph | string>): AdfBulletList {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [typeof item === "string" ? paragraph(item) : item],
    })),
  };
}

export function rule(): AdfRule {
  return { type: "rule" };
}

export function panel(
  panelType: "info" | "note" | "success" | "warning" | "error",
  ...paragraphs: AdfParagraph[]
): AdfPanel {
  return {
    type: "panel",
    attrs: { panelType },
    content: paragraphs.length > 0 ? paragraphs : [paragraph("")],
  };
}

export function doc(nodes: AdfBlockNode[]): AdfDocument {
  return { type: "doc", version: 1, content: nodes };
}

// ─── Summary extraction from artifact markdown ─────────────────────────────

const INTRO_CHAR_LIMIT = 600;
const MAX_SECTIONS = 8;

export type ArtifactSummary = {
  intro: string;
  sections: string[];
  /** For review.md: extracted READY / AMEND / REWRITE. */
  verdict?: "READY" | "AMEND" | "REWRITE" | null;
};

/**
 * Cheap heuristic summary: strip YAML frontmatter, grab the first non-empty
 * non-heading paragraph as `intro`, collect H2 section titles as `sections`,
 * and for review artifacts pull out the `**READY|AMEND|REWRITE**` verdict.
 */
export function extractSummary(markdown: string, kind?: string): ArtifactSummary {
  let body = markdown;

  // Strip leading YAML frontmatter.
  const fm = body.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (fm) body = body.slice(fm[0].length);

  // Grab first non-heading non-empty paragraph for intro.
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  let intro = "";
  for (const p of paragraphs) {
    if (p.startsWith("#")) continue;
    intro = p.replace(/\s+/g, " ").trim();
    break;
  }
  if (intro.length > INTRO_CHAR_LIMIT) {
    intro = intro.slice(0, INTRO_CHAR_LIMIT).trimEnd() + "…";
  }

  // Collect H2 section titles (## Section).
  const sections: string[] = [];
  const h2Re = /^##\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = h2Re.exec(body)) && sections.length < MAX_SECTIONS) {
    sections.push(m[1]!.trim());
  }

  // Review verdict (match the bolded keyword anywhere in the doc).
  let verdict: ArtifactSummary["verdict"];
  if (kind === "review") {
    const verdictMatch = body.match(/\*\*(READY|AMEND|REWRITE)\*\*/);
    verdict = verdictMatch ? (verdictMatch[1] as "READY" | "AMEND" | "REWRITE") : null;
  }

  return { intro, sections, verdict };
}

// ─── Comment document builder ──────────────────────────────────────────────

export type ApproveCommentInput = {
  prUrl: string;
  jiraKey: string;
  title: string;
  artifacts: Array<{
    kind: "brainstorm" | "plan" | "review";
    filename: string;
    markdown: string;
  }>;
};

const KIND_LABEL: Record<"brainstorm" | "plan" | "review", string> = {
  brainstorm: "Brainstorm",
  plan: "Plan",
  review: "Review",
};

const VERDICT_PANEL: Record<
  "READY" | "AMEND" | "REWRITE",
  "success" | "warning" | "error"
> = {
  READY: "success",
  AMEND: "warning",
  REWRITE: "error",
};

/**
 * Rich Jira comment summarising each artifact produced for the ticket,
 * with the PR link at the top.
 */
export function prCommentDoc(input: ApproveCommentInput): AdfDocument {
  const nodes: AdfBlockNode[] = [
    paragraph(strong("Automated draft PR opened by ai-ops: "), link(input.prUrl, input.prUrl)),
    paragraph(strong("Ticket: "), text(input.title)),
    rule(),
  ];

  for (const a of input.artifacts) {
    const summary = extractSummary(a.markdown, a.kind);
    nodes.push(heading(3, KIND_LABEL[a.kind]));
    nodes.push(paragraph(code(a.filename)));

    // Verdict panel (review only).
    if (a.kind === "review" && summary.verdict) {
      nodes.push(panel(VERDICT_PANEL[summary.verdict], paragraph(strong(`Verdict: ${summary.verdict}`))));
    }

    if (summary.intro) {
      nodes.push(paragraph(summary.intro));
    }
    if (summary.sections.length > 0) {
      nodes.push(paragraph(strong("Sections:")));
      nodes.push(bulletList(summary.sections));
    }
  }

  nodes.push(rule());
  nodes.push(
    paragraph(
      text("Review, refine, then undraft the PR when ready to implement. "),
      text("(Generated by multiportal-ai-ops.)", [{ type: "em" }]),
    ),
  );

  return doc(nodes);
}

// ─── Implementation-complete comment ───────────────────────────────────────

export type ImplementCommentInput = {
  prUrl: string;
  jiraKey: string;
  title: string;
  /**
   * One-line commit summaries from `git log origin/main..HEAD --pretty='%h %s'`.
   * First line = most recent commit.
   */
  commits: Array<{ sha: string; subject: string }>;
  /** Full markdown of the implementation artifact, if persisted. */
  implementationMarkdown?: string;
};

/**
 * Jira comment posted when ce:work finishes cleanly. Summarises what
 * was built, links to the live PR, and bullets the commits so
 * stakeholders can skim without opening GitHub.
 */
export function implementCommentDoc(input: ImplementCommentInput): AdfDocument {
  const summary = input.implementationMarkdown
    ? extractSummary(input.implementationMarkdown, "implementation")
    : null;

  const nodes: AdfBlockNode[] = [
    heading(3, "Implementation complete"),
    paragraph(
      text("Live PR: "),
      link(input.prUrl, input.prUrl),
    ),
    paragraph(strong("Ticket: "), text(input.title)),
    rule(),
  ];

  // Commits bulleted — this is the meat for human reviewers.
  if (input.commits.length > 0) {
    nodes.push(heading(4, "Commits"));
    nodes.push(
      bulletList(
        input.commits.map((c) => {
          const prefix = `${c.sha} · ${c.subject}`;
          return paragraph(code(c.sha), text(" "), text(c.subject));
        }),
      ),
    );
  }

  // Intro paragraph + section TOC from the implementation artifact
  // (if the agent wrote one).
  if (summary?.intro) {
    nodes.push(heading(4, "Summary"));
    nodes.push(paragraph(summary.intro));
  }
  if (summary && summary.sections.length > 0) {
    nodes.push(paragraph(strong("Sections:")));
    nodes.push(bulletList(summary.sections));
  }

  nodes.push(rule());
  nodes.push(
    paragraph(
      text("Review the diff on GitHub and undraft the PR when ready to merge. "),
      text("(Generated by multiportal-ai-ops.)", [{ type: "em" }]),
    ),
  );

  return doc(nodes);
}

/** Best-effort plain-text extraction from Jira's nested ADF descriptions. */
export function adfToPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    const inner = n.content.map(adfToPlainText).join("");
    if (n.type === "paragraph" || n.type === "heading") return inner + "\n\n";
    if (n.type === "hardBreak") return "\n";
    return inner;
  }
  return "";
}
