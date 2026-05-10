import { describe, expect, it } from "vitest";
import {
  buildImplementationShipNote,
  extractShipNoteSections,
} from "@/server/jira/shipNote";

// ─── Parser tests ────────────────────────────────────────────────────────

describe("extractShipNoteSections — happy paths", () => {
  it("parses all four required sections", () => {
    const md = `## Summary

This PR adds the X feature to Y.

## User-visible changes

- New "Approve" button
- Toast on success

## Risk areas

- \`server/git/approve.ts\` rewritten
- New endpoint exposed

## Test Plan

- Click Approve, verify toast
- Verify endpoint returns 200
`;
    const out = extractShipNoteSections(md);
    expect(out.summary).toBe("This PR adds the X feature to Y.");
    expect(out.userVisibleChanges).toEqual([
      'New "Approve" button',
      "Toast on success",
    ]);
    expect(out.riskAreas).toEqual([
      "`server/git/approve.ts` rewritten",
      "New endpoint exposed",
    ]);
    expect(out.testPlan).toEqual([
      "Click Approve, verify toast",
      "Verify endpoint returns 200",
    ]);
    expect(out.optional).toEqual([]);
    expect(out.complete).toBe(true);
  });

  it("strips YAML frontmatter before parsing", () => {
    const md = `---
title: Test
---

## Summary

Body.

## User-visible changes
- a
## Risk areas
- b
## Test Plan
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.summary).toBe("Body.");
    expect(out.complete).toBe(true);
  });

  it("preserves recognised optional sections in source order", () => {
    const md = `## Summary
Body.
## User-visible changes
- a
## Files Touched
- foo.ts
- bar.ts
## Risk areas
- b
## Out of scope
- not done yet
## Test Plan
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.optional).toEqual([
      { heading: "Files Touched", body: "- foo.ts\n- bar.ts" },
      { heading: "Out of scope", body: "- not done yet" },
    ]);
    expect(out.complete).toBe(true);
  });
});

describe("extractShipNoteSections — heading variations", () => {
  it("accepts h3 instead of h2", () => {
    const md = `### Summary
Body.
### User-visible changes
- a
### Risk areas
- b
### Test Plan
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.summary).toBe("Body.");
    expect(out.complete).toBe(true);
  });

  it("matches headings case-insensitively", () => {
    const md = `## SUMMARY
Body.
## user-visible changes
- a
## RISK AREAS
- b
## test plan
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.complete).toBe(true);
  });

  it("matches 'User visible' (no hyphen) and 'Risk' (no 'areas')", () => {
    const md = `## Summary
Body.
## User visible
- a
## Risk
- b
## Test Plan
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.userVisibleChanges).toEqual(["a"]);
    expect(out.riskAreas).toEqual(["b"]);
    expect(out.complete).toBe(true);
  });
});

describe("extractShipNoteSections — strict allowlist", () => {
  it("does NOT accept '## Testing' (close but not in allowlist)", () => {
    const md = `## Summary
Body.
## User-visible changes
- a
## Risk areas
- b
## Testing
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.testPlan).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("drops unrecognised headings entirely", () => {
    const md = `## Summary
Body.
## User-visible changes
- a
## Risk areas
- b
## Test Plan
- c
## Random thoughts
- not-shipped
## Notes for future
- also-not-shipped
`;
    const out = extractShipNoteSections(md);
    expect(out.optional).toEqual([]);
    expect(out.complete).toBe(true);
  });
});

describe("extractShipNoteSections — missing sections + degraded inputs", () => {
  it("returns complete=false when Test Plan is missing", () => {
    const md = `## Summary
Body.
## User-visible changes
- a
## Risk areas
- b
`;
    const out = extractShipNoteSections(md);
    expect(out.testPlan).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("returns all-empty + complete=false on empty markdown", () => {
    const out = extractShipNoteSections("");
    expect(out.summary).toBe("");
    expect(out.userVisibleChanges).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("does not mistake a bullet-only Summary for prose", () => {
    const md = `## Summary
- bulletted instead of prose
## User-visible changes
- a
## Risk areas
- b
## Test Plan
- c
`;
    const out = extractShipNoteSections(md);
    // Summary's body is a bullet — paragraphFrom returns "" because
    // the agent put bullets where prose was expected.
    expect(out.summary).toBe("");
    expect(out.complete).toBe(false);
  });

  it("falls back to paragraph-as-bullet when a list section has no bullet markers", () => {
    const md = `## Summary
Body.
## User-visible changes
just one paragraph, no bullets
## Risk areas
- b
## Test Plan
- c
`;
    const out = extractShipNoteSections(md);
    expect(out.userVisibleChanges).toEqual(["just one paragraph, no bullets"]);
  });
});

// ─── Renderer tests ──────────────────────────────────────────────────────

const sampleSections = {
  summary: "This PR adds the X feature.",
  userVisibleChanges: ["New button", "New toast"],
  riskAreas: ["server/foo.ts rewritten"],
  testPlan: ["Click thing, see other thing"],
  optional: [],
  complete: true,
};

const sampleCommits = [
  { sha: "abc1234", subject: "feat(x): new button" },
  { sha: "def5678", subject: "test(x): smoke" },
];

describe("buildImplementationShipNote — happy path", () => {
  it("renders both adf + markdown with the cycle-1 heading", () => {
    const out = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "Add X",
      prUrl: "https://github.com/owner/repo/pull/42",
      branch: "TEST-1-ai",
      commits: sampleCommits,
      sections: sampleSections,
    });

    // Markdown contains all four section headings + the cycle-1 main heading.
    expect(out.markdown).toMatch(/^## Implementation complete\b/);
    expect(out.markdown).toContain("### Summary");
    expect(out.markdown).toContain("### User-visible changes");
    expect(out.markdown).toContain("### Risk areas");
    expect(out.markdown).toContain("### Test Plan");
    expect(out.markdown).toContain("### Commits");
    expect(out.markdown).toContain("`abc1234` feat(x): new button");
    expect(out.markdown).toContain("**Ticket:** TEST-1 — Add X");
    expect(out.markdown).toContain("**PR:** https://github.com/owner/repo/pull/42");
    expect(out.markdown).toContain("**Plan:** `docs/plans/TEST-1-plan.md`");

    // ADF doc has the right top-level heading text and contains the four h3 sections.
    const adfHeadings = out.adf.content
      .filter((n) => n.type === "heading")
      .map((h) => {
        const heading = h as {
          attrs: { level: number };
          content: Array<{ text?: string }>;
        };
        return {
          level: heading.attrs.level,
          text: heading.content.map((c) => c.text ?? "").join(""),
        };
      });
    expect(adfHeadings[0]).toEqual({ level: 2, text: "Implementation complete" });
    expect(adfHeadings.some((h) => h.text === "Summary" && h.level === 3)).toBe(true);
    expect(adfHeadings.some((h) => h.text === "User-visible changes")).toBe(true);
    expect(adfHeadings.some((h) => h.text === "Risk areas")).toBe(true);
    expect(adfHeadings.some((h) => h.text === "Test Plan")).toBe(true);
    expect(adfHeadings.some((h) => h.text === "Commits")).toBe(true);
  });
});

describe("buildImplementationShipNote — cycle variant", () => {
  it("swaps the heading to 'QA fix pushed — round N' for cycleNumber > 1", () => {
    const out = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "Add X",
      prUrl: "https://github.com/owner/repo/pull/42",
      branch: "TEST-1-ai",
      commits: sampleCommits,
      sections: sampleSections,
      cycleNumber: 3,
    });
    expect(out.markdown).toMatch(/^## QA fix pushed — round 3\b/);
  });

  it("renders cycle-1 heading when cycleNumber is 1 or absent", () => {
    const a = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "Add X",
      prUrl: "https://example.com/pr",
      branch: "b",
      commits: [],
      sections: sampleSections,
      cycleNumber: 1,
    });
    expect(a.markdown).toMatch(/^## Implementation complete\b/);

    const b = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "Add X",
      prUrl: "https://example.com/pr",
      branch: "b",
      commits: [],
      sections: sampleSections,
    });
    expect(b.markdown).toMatch(/^## Implementation complete\b/);
  });
});

describe("buildImplementationShipNote — placeholder behaviour", () => {
  it("renders placeholder text for missing required sections", () => {
    const incompleteSections = {
      summary: "",
      userVisibleChanges: [],
      riskAreas: ["a"],
      testPlan: [],
      optional: [],
      complete: false,
    };
    const out = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "T",
      prUrl: "https://example.com/pr",
      branch: "b",
      commits: [],
      sections: incompleteSections,
    });
    // Three placeholders for the three empty sections.
    const placeholderCount = out.markdown.split("_section not provided").length - 1;
    expect(placeholderCount).toBe(3);
    expect(out.markdown).toContain("- a"); // risk areas still rendered
  });
});

describe("buildImplementationShipNote — optional sections", () => {
  it("appends recognised optional sections after the four required, in source order", () => {
    const sectionsWithOptional = {
      ...sampleSections,
      optional: [
        { heading: "Files Touched", body: "- server/foo.ts\n- server/bar.ts" },
        { heading: "Out of scope", body: "- did not refactor X" },
      ],
    };
    const out = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "T",
      prUrl: "https://example.com/pr",
      branch: "b",
      commits: sampleCommits,
      sections: sectionsWithOptional,
    });
    const filesIdx = out.markdown.indexOf("### Files Touched");
    const outOfScopeIdx = out.markdown.indexOf("### Out of scope");
    const testPlanIdx = out.markdown.indexOf("### Test Plan");
    const commitsIdx = out.markdown.indexOf("### Commits");
    expect(filesIdx).toBeGreaterThan(testPlanIdx);
    expect(outOfScopeIdx).toBeGreaterThan(filesIdx);
    expect(commitsIdx).toBeGreaterThan(outOfScopeIdx);
  });
});

describe("buildImplementationShipNote — commits absent", () => {
  it("omits the Commits section when no commits are passed", () => {
    const out = buildImplementationShipNote({
      jiraKey: "TEST-1",
      title: "T",
      prUrl: "https://example.com/pr",
      branch: "b",
      commits: [],
      sections: sampleSections,
    });
    expect(out.markdown).not.toContain("### Commits");
    const adfHeadings = out.adf.content
      .filter((n) => n.type === "heading")
      .map((h) =>
        (h as { content: Array<{ text?: string }> }).content
          .map((c) => c.text ?? "")
          .join(""),
      );
    expect(adfHeadings).not.toContain("Commits");
  });
});
