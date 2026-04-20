// Minimal Atlassian Document Format helpers. Jira's /comment endpoint and
// most multi-line fields require ADF, not plain text or markdown.
// Spec: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

export type AdfText = { type: "text"; text: string };
export type AdfParagraph = { type: "paragraph"; content: AdfText[] };
export type AdfCodeBlock = {
  type: "codeBlock";
  attrs?: { language?: string };
  content: AdfText[];
};
export type AdfBlockNode = AdfParagraph | AdfCodeBlock;

export type AdfDocument = {
  type: "doc";
  version: 1;
  content: AdfBlockNode[];
};

export function paragraph(text: string): AdfParagraph {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

export function codeBlock(text: string, language?: string): AdfCodeBlock {
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    content: [{ type: "text", text }],
  };
}

export function doc(nodes: AdfBlockNode[]): AdfDocument {
  return { type: "doc", version: 1, content: nodes };
}

/** Convenience for the Approve & PR comment body. */
export function prCommentDoc(prUrl: string, summary: string): AdfDocument {
  return doc([paragraph(`Automated draft PR opened by ai-ops: ${prUrl}`), paragraph(summary)]);
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
