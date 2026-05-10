---
title: Implementation handoff improvements — richer Jira comment + PR description rewrite
type: feat
status: active
date: 2026-05-05
origin: docs/brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md
---

# Implementation handoff improvements

## Overview

When `Approve Implementation` fires today, the QA tester reading the
Jira "Implementation complete" comment gets a thin handoff: PR link,
ticket title, commits-bulleted, intro paragraph + section TOC from
`implementation.md`. No file list, no test plan. Meanwhile the GitHub
PR description is the planning-stage body that `approveAndPr` set days
earlier — bullets pointing at brainstorm/plan/review docs, never
updated to reflect what was actually built.

This plan tightens the `ce:work` prompt contract to require four
sections (Summary, User-visible changes, Risk areas, Test Plan),
introduces a single shared renderer, and adds a step to
`implementComplete` that rewrites the PR description with the same
ship-note body. Outcome: a QA tester reading the Jira comment alone
can identify what's new, what's risky, and which scenarios to test —
without opening the PR, the diff, or the implementation.md artifact.

Carries forward all three resolved decisions from the brainstorm
(see brainstorm: `docs/brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md`):
- Source = agent-emitted (new `## Test Plan` required section)
- Contract = standard ship-note (4 required sections)
- Rendering = identical body for Jira comment and PR description

The plan also resolves the brainstorm's 6 open questions (defaults
in the doc; rationale carried into the relevant phases below).

## Problem Statement

The QA tester is the most-affected reader of the implementation
handoff and is the most starved for information. Today's flow:

1. PR opens (planning-stage body) → reviewers see "review the
   plan docs."
2. ce:work pushes commits → PR has new commits but description is
   stale.
3. Approve Implementation fires → Jira gets a thin comment, PR body
   stays stale, Jira transitions to Code Review.
4. QA opens Jira → sees PR link + commits + 1-paragraph intro →
   has to click into PR → sees stale planning body → has to click
   into the diff or the `implementation.md` file in the repo to
   actually figure out what shipped.

That's three navigation hops between "I'm assigned to QA this" and
"I know what to test." Every hop is friction; on a healthy QA team
the friction is tolerable but never useful. On a 4-person team
where QA also writes specs and triages tickets, the friction is the
difference between same-day verification and three-day-old PRs
sitting in Code Review.

The fix isn't more channels or more notification — it's putting the
information at the first stop. Jira IS the QA tester's first stop;
the PR is the developer reviewer's first stop. Both should answer
"what shipped, what's risky, what should I poke at?" without a
second hop.

## Proposed Solution

Three layers, shipped together (single PR):

### 1. `ce:work` prompt contract

`workPrompt` in `server/agents/registry.ts` gains ~10 lines
declaring the four required sections and their format. The agent
already produces unstructured prose — making it structured costs
nothing in agent quality and unlocks deterministic parsing.

### 2. Shared renderer + section parser

Two new helpers in `server/jira/adf.ts` (or a new
`server/jira/shipNote.ts` module — colocation decision in Phase B):

- `extractShipNoteSections(markdown)` — forgiving parser that
  reads the four required sections + any recognised optional ones.
  Heading match is case-insensitive substring + accepts h2 OR h3.
- `buildImplementationShipNote({ ... })` — single function that
  returns `{ adf, markdown }`: the ADF document for the Jira
  comment, and the markdown body for the PR description. Both
  byte-identical in content (header + 4 sections + commits +
  footer).

### 3. `implementComplete` Step 1c — PR description rewrite

New best-effort step inserted between today's `gh pr ready`
(Step 1b) and the Jira comment (Step 2):

- Compute the markdown ship-note via `buildImplementationShipNote`.
- Run `gh pr edit <branch> --body-file <tmp>` to replace the body.
- Audit `pr.description_updated` on success,
  `pr.description_update_failed` (warn-only) on failure.
- Failures DO NOT block lane-to-done — the Jira comment + PR
  commits are the load-bearing handoff; the description update is
  presentation polish. (Differs from Step 2's hard-fail because
  Step 2's failure means QA has no notification at all.)

The Jira comment side (Step 2) swaps `implementCommentDoc(...)` for
`buildImplementationShipNote(...).adf`. Same call site, same return
shape, body changes.

### Resolutions of brainstorm open questions

| Open Q | Resolution | Rationale |
|---|---|---|
| 1. QA-fix comment symmetry | **Yes** — `postQaFixComment` (cycle N>1) uses the same shared renderer with a `cycleNumber` parameter that swaps the heading from "Implementation complete" to "QA fix pushed — round N" | Same QA reads both. Consistency is high-value, low-cost. The renderer takes one extra optional parameter. |
| 2. Section-missing behaviour | **Soft fail with placeholder text** — "_Test Plan section not provided by the agent — see the diff for details._" Approve Implementation proceeds. | Hard-fail invites lock-out incidents when the prompt drifts (a model update misses a heading, etc.). Soft-fail is visible and self-correcting (operator sees the placeholder and re-runs ce:work). |
| 3. Section parser robustness | **Forgiving** — case-insensitive substring match (`/^(##\|###)\s+.*test plan/i`, etc.); accepts h2 OR h3; trims whitespace. | Strict matching is brittle to model-emitted variations; forgiving parser is ~5 extra LOC. |
| 4. In-flight cards at deploy | **No migration; #2 default handles it** | Cards mid-implement at deploy time render with placeholder text where sections are missing. New cards built post-deploy get the contract; old cards degrade gracefully. |
| 5. Planning docs footer link | **Both surfaces include a footer with markdown-relative link** to `docs/plans/<key>-plan.md`; the Jira side ALSO renders the path as plain text since ADF doesn't render relative-to-repo links. | Devs on GitHub click; PMs/QA on Jira read the path. Single line of footer either way. |
| 6. Custom optional sections | **Include if recognised** (Files Touched, Out of scope, Migration notes, Rollback) appended after the four required, in the order they appear. Unrecognised headings dropped (don't ship random agent thoughts to the QA handoff). | Allowlist keeps the comment focused; explicit recognised list documents intent. |

## Technical Approach

### Architecture

Three reads, three writes — all localised:

```
ce:work emits implementation.md with the 4 required sections
        ↓
persistArtifactsForRun stores it in artifacts table (existing)
        ↓
[ Operator clicks Approve Implementation ]
        ↓
implementComplete reads latest implementation artifact (existing)
        ↓
extractShipNoteSections(markdown) → { summary, userVisible, risk, test, optional }
        ↓
buildImplementationShipNote({ sections, commits, prUrl, ... })
        → { adf, markdown }
        ↓ (parallel)
   ├─ gh pr edit --body-file <tmp> ← new Step 1c (best-effort)
   └─ postComment(jiraKey, adf)    ← Step 2 (existing call site, new body)
```

### Data flow

The agent emits markdown; we parse it once at Approve Implementation
time; we render to two formats (ADF for Jira, markdown for GitHub);
both surfaces show the same content. No persistence change — the
renderer reads the existing `implementation.md` artifact from the
DB.

### Implementation phases

Total: **~3 days of focused work**, single PR. Phases A-B are pure
helpers (testable in isolation); C-E wire them in.

#### Phase A: Tighten the `ce:work` prompt contract (~3h)

Files:
- `server/agents/registry.ts` — `workPrompt` function. Add a
  "Required output structure" section to the prompt instructing
  the agent to produce `implementation.md` with these four h2
  sections in order:

  ```
  ## Summary
  One paragraph: what was built, in plain language.

  ## User-visible changes
  Bullets — each one a thing the operator/end-user sees differently
  after this PR lands. Empty bullet list if there are no
  user-visible changes (e.g., pure refactor).

  ## Risk areas
  Bullets — files/flows/integrations that could regress, ranked
  highest blast-radius first. Reference specific paths.

  ## Test Plan
  Bullets — concrete verification scenarios, written as imperative
  steps a tester can follow. One per acceptance criterion from the
  plan, plus edge cases worth checking.
  ```

  Plus: optional sections allowed (`## Files Touched`,
  `## Out of scope`, `## Migration notes`, `## Rollback`) — agent
  emits them when relevant.

Acceptance:
- [ ] `workPrompt` declares all four required sections with
  one-line descriptions of each.
- [ ] Optional sections list documented in a comment so future
  prompt changes don't silently lose support for them.
- [ ] Existing prompt content (TodoWrite usage, "do not commit",
  Bash gating) preserved.

#### Phase B: `extractShipNoteSections` parser (~4h)

Files:
- New helper in `server/jira/adf.ts` (or new
  `server/jira/shipNote.ts` if `adf.ts` is already crowded — see
  below for recommendation).

Recommendation: NEW file `server/jira/shipNote.ts`. `adf.ts` is
already at 337 lines doing both ADF primitives AND comment
builders. Pulling the ship-note logic into its own file:
- Keeps adf.ts focused on primitives + the legacy
  `implementCommentDoc` (which we'll refactor to call into
  shipNote.ts in Phase D).
- Makes the parser + renderer testable in isolation without
  dragging in everything `adf.ts` re-exports.
- Mirrors the existing pattern of `amendComment.ts` and
  `qaFixComment.ts` living next to `client.ts`.

Public API:

```typescript
// server/jira/shipNote.ts (NEW)

export type ShipNoteSections = {
  summary: string;          // empty string if missing
  userVisibleChanges: string[];
  riskAreas: string[];
  testPlan: string[];
  optional: Array<{ heading: string; body: string }>;
  /** True when ALL four required sections were present in the input. */
  complete: boolean;
};

/** Parse the agent's implementation.md into the ship-note shape.
 *  Forgiving: case-insensitive heading match, h2 OR h3, recognised
 *  optional sections preserved in source order. Unrecognised
 *  headings dropped.
 *
 *  Heading match patterns:
 *    summary          /^summary$/i
 *    userVisible      /^user[ -]?visible( changes)?$/i
 *    risk             /^risk( areas?)?$/i
 *    testPlan         /^test plan$/i
 *    optional list    /^files touched$/i, /^out of scope$/i,
 *                     /^migration notes?$/i, /^rollback( notes?)?$/i
 */
export function extractShipNoteSections(markdown: string): ShipNoteSections;
```

Tests (`tests/shipNote.test.ts`):
- Round-trip a fully-populated implementation.md with all four
  sections + 2 optional sections; assert structured output.
- Missing-section cases: omit Test Plan → returns empty array +
  `complete: false`.
- Heading variations: `## Test Plan`, `### Test Plan`,
  `## TEST PLAN`, `## Test plan` — all match.
- Heading misnames: `## Testing`, `## Tests`, `## QA notes` —
  use the strict allowlist (don't accept). Document why.
- Optional-section recognition: `## Files Touched` keeps,
  `## Random thoughts` drops.
- Empty / no-headings markdown: returns all-empty +
  `complete: false`.

Acceptance:
- [ ] All five test categories above pass.
- [ ] Parser is < 100 LOC (forgiving but compact).
- [ ] `complete: false` when ANY required section is empty.

#### Phase C: `buildImplementationShipNote` renderer (~5h)

Files:
- `server/jira/shipNote.ts` — adds the renderer.

Public API:

```typescript
export type ShipNoteInput = {
  jiraKey: string;
  title: string;
  prUrl: string;
  /** Branch — used to construct the relative path to plan.md in
   *  the footer link. */
  branch: string;
  commits: Array<{ sha: string; subject: string }>;
  /** Output of extractShipNoteSections on the latest
   *  implementation.md. */
  sections: ShipNoteSections;
  /** When > 1, prefix the heading with "QA fix pushed — round N"
   *  instead of "Implementation complete". Resolves brainstorm
   *  open question #1. */
  cycleNumber?: number;
};

export type ShipNoteRendered = {
  adf: AdfDocument;       // for postComment to Jira
  markdown: string;       // for `gh pr edit --body-file`
};

export function buildImplementationShipNote(
  input: ShipNoteInput,
): ShipNoteRendered;
```

Body shape (both surfaces, byte-identical content):

```
## {heading} — {jiraKey}

{summary paragraph or "_Summary section not provided by the agent — see the diff for details._"}

### User-visible changes
- bullet
- bullet

### Risk areas
- bullet
- bullet

### Test Plan
- bullet
- bullet

### {optional section heading}    ← repeated for each recognised optional
- bullet

### Commits
- `{sha}` — {subject}

---

PR: {prUrl}
Plan: docs/plans/{jiraKey}-plan.md
Generated by LawStack/aiops.
```

Where `{heading}` is `Implementation complete` for cycle 1 OR
`QA fix pushed — round {N}` for cycle N>1.

The markdown form is direct; the ADF form runs through helpers
in `adf.ts` (`heading`, `paragraph`, `bulletList`, `code`,
`link`, `rule`).

Tests (`tests/shipNote.test.ts` continued):
- Renderer with full sections produces both adf + markdown
  matching snapshots.
- Missing-section input renders placeholders, not crashes.
- `cycleNumber: 2` swaps the heading.
- Markdown form is valid (no broken bullet syntax, no unclosed
  code spans).

Acceptance:
- [ ] Both formats render identical CONTENT (the wording in the
  Jira ADF and the markdown should match line-for-line in the
  body sections).
- [ ] Missing-section placeholders are clear ("_X section not
  provided…_").
- [ ] Footer line includes both PR url + relative-path-to-plan
  reference.

#### Phase D: Wire `implementCommentDoc` to use the shared renderer (~2h)

Files:
- `server/jira/adf.ts` — `implementCommentDoc` body shrinks: it
  calls `buildImplementationShipNote(...).adf` and returns it.
- `server/git/implementComplete.ts` Step 2 — call site updates
  to pass the new input shape (sections + branch are new args).

The legacy `ImplementCommentInput` type stays exported (other
callers may exist; verified zero today via grep). Body changes;
shape stays.

Acceptance:
- [ ] Cycle-1 Jira comment now contains all four sections.
- [ ] All existing implementCommentDoc callers compile + run
  without changes.
- [ ] Comment renders the legacy commits list (preserved
  behaviour).

#### Phase E: New Step 1c in `implementComplete` — PR description rewrite (~3h)

Files:
- `server/git/implementComplete.ts` — between Step 1b
  (`gh pr ready`) and Step 2 (Jira comment), insert:

```typescript
// ─── Step 1c: rewrite PR description with the implementation
//             ship-note (replaces the planning-stage body that
//             approveAndPr set). Best-effort: a failure here
//             doesn't block the Jira comment or the lane move,
//             since the PR commits + Jira comment are the
//             load-bearing handoff. Audit row makes failures
//             discoverable for ops.
if (wt?.path && !hasPriorAudit(taskId, "pr.description_updated")) {
  try {
    const { writeFile, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tmpPath = path.join(tmpdir(), `aiops-pr-body-${runId}.md`);
    await writeFile(tmpPath, shipNoteMarkdown, "utf8");
    try {
      await exec("gh", ["pr", "edit", pr.branch, "--body-file", tmpPath], {
        cwd: wt.path,
        env: ghEnv(),
      });
      audit({
        action: "pr.description_updated",
        taskId,
        runId,
        payload: { branch: pr.branch, prUrl: pr.prUrl },
      });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    warnings.push(`gh pr edit body failed: ${(err as Error).message}`);
    audit({
      action: "pr.description_update_failed",
      taskId,
      runId,
      payload: { error: (err as Error).message },
    });
  }
}
```

The `shipNoteMarkdown` value comes from
`buildImplementationShipNote(input).markdown`, computed once at
the top of `implementComplete` and reused by Step 1c + Step 2.

`hasPriorAudit` check makes the step idempotent: re-running
`implementComplete` won't re-edit a PR whose description is
already updated.

Acceptance:
- [ ] PR description after Approve Implementation matches the
  Jira comment body (verified by manual smoke or fetching via
  `gh pr view --json body`).
- [ ] Re-running implementComplete on a finalised task is a no-op
  for the PR-edit step (audit guard).
- [ ] `gh pr edit` failures are warn-only — Step 2 still fires.

#### Phase F: QA-fix comment symmetry (~1h)

Files:
- `server/jira/qaFixComment.ts` — `postQaFixComment` body shrinks
  to call `buildImplementationShipNote({ ..., cycleNumber: N })`
  and post the resulting ADF.

The custom QA-fix-specific text (e.g., "Ready for re-test" panel)
stays as a renderer parameter or is omitted (consistency with
cycle 1 wins; if the panel is high-value it can be added back as
an optional renderer flag).

Acceptance:
- [ ] Cycle-2 Jira comment contains the same four sections as
  cycle-1, with "QA fix pushed — round 2" heading.
- [ ] Existing `postQaFixComment` audit + error semantics
  preserved.

#### Phase G: Tests + smoke + docs (~2h)

Files:
- `tests/shipNote.test.ts` — covers Phase B + C (parser + renderer
  unit tests, ~12 cases).
- Manual smoke checklist in PR description for the integration
  parts (Phases D, E, F) — node-only test infra can't exercise the
  `gh pr edit` shellout end-to-end.
- `README.md` (no change — implementation flow already documented).
- Code comment in `server/jira/shipNote.ts` explaining the strict-
  vs-forgiving heading allowlist trade-off (so future contributors
  don't loosen the parser to accept "## Tests" and silently shift
  semantics).

Acceptance:
- [ ] All existing tests still green.
- [ ] At least 12 new tests in `tests/shipNote.test.ts`.
- [ ] `npm run typecheck`, `npm run build` clean.
- [ ] Manual smoke: take a card through the full flow, verify both
  surfaces show the new ship-note.

## Alternative Approaches Considered

### A. Single shared renderer (CHOSEN)

- One module renders both ADF + markdown from the same parsed
  sections. Cycle-1 and cycle-N comments use it via parameter.
- **Why chosen:** matches the brainstorm decision (Q3 = identical
  content). Single source of truth; no divergence drift.

### B. Two separate renderers

- One ADF renderer for Jira, one markdown renderer for PR
  description. Each tuned for its surface.
- **Skipped:** the brainstorm explicitly resolved Q3 to identical
  content. Two renderers invite drift.

### C. Plan-derived test plan

- Read the plan's "Acceptance Criteria" section at Approve time
  and reproduce in the comment.
- **Skipped:** brainstorm Q1 chose agent-emitted. Plans drift from
  built code; agent has freshest context.

### D. Operator-typed test plan via modal

- Modal pops up before Approve Implementation; operator types the
  test plan or edits an agent-generated draft.
- **Skipped:** brainstorm Q1 explicitly rejected this — turns a
  fast click into a typing chore.

### E. Hard-fail Approve when sections missing

- Block the Approve flow if `implementation.md` lacks any of the
  four required sections.
- **Skipped:** brainstorm Q2 chose graceful degrade. Hard-fail
  invites lockout when the agent prompt drifts (model update
  changes heading style, etc.).

## System-Wide Impact

### Interaction Graph

When the operator clicks Approve Implementation:

1. POST `/api/tasks/[id]/approve-implementation` → `implementComplete`.
2. Step 1: commit + push (existing).
3. Step 1b: `gh pr ready` (existing).
4. **Step 1c: NEW** — read latest implementation artifact →
   `extractShipNoteSections` → `buildImplementationShipNote` →
   write markdown to tmp → `gh pr edit --body-file` →
   audit `pr.description_updated`.
5. Step 2: `postComment(jiraKey, shipNote.adf)` (body shape changed
   via the shared renderer).
6. Step 3: `transitionIssueToName(jiraKey, "Code Review")`
   (existing; QA cycle skips per Layer B's branch).
7. Step 4: `tasks.currentLane = "done"` + audit (existing,
   atomic).

### Error & Failure Propagation

| Failure | Where | Behaviour |
|---|---|---|
| `extractShipNoteSections` finds < 4 required sections | renderer | Returns `complete: false`; renderer fills missing slots with placeholder text; flow proceeds. |
| `gh pr edit` fails (network, GitHub down, branch mismatch) | Step 1c | Warn-only. Audit `pr.description_update_failed`. Step 2 still fires; lane still moves to `done`. PR description stays as the planning-stage body. |
| `postComment` fails | Step 2 | Match existing behaviour: hard-fail, lane stays at `implement`, operator retries Approve Implementation. (Comment is the only QA notification; can't degrade.) |
| Re-run on finalised task | Step 1c | `hasPriorAudit("pr.description_updated")` short-circuits; Step 1c is a no-op. |
| Implementation artifact missing entirely | renderer | Returns all-placeholder ship-note. Surfaces clearly that the agent didn't write the file. |
| Markdown body exceeds GitHub's 65k char limit | Step 1c | `gh pr edit` returns an error; warn-logged. Practical risk: low (agent-emitted markdown is typically <5k). v2: truncate with "(...truncated)" footer. |
| Markdown contains characters that break ADF rendering | Step 2 | `buildImplementationShipNote.adf` uses ADF primitive helpers, not raw markdown injection — so this can't happen via the renderer. The risk is in raw-text content of bullets containing characters Jira's API rejects. v1: trust ADF primitives to escape correctly. |

### State Lifecycle Risks

| Scenario | Behaviour |
|---|---|
| Approve clicked twice rapidly | `withRunLock("approve:${taskId}")` — wait, that's the approveAndPr lock. `implementComplete` doesn't have a lock today. Add one for Step 1c idempotency? `hasPriorAudit` covers re-runs, but not concurrent runs. **Decision:** the existing audit-guard pattern is sufficient — concurrent invocations would BOTH check the audit, BOTH miss (no row yet), BOTH `gh pr edit` (idempotent at GitHub — same body twice produces no diff), THEN both insert audit rows (one extra audit row, no functional impact). Document and move on. |
| Cycle-N approve where cycle 1's PR description has the planning bullets, cycle 2's run rewrites with the cycle-2 ship-note | Each Approve Implementation rewrites the description. Cycle 2's body REPLACES cycle 1's — this is desired (the PR now reflects what's currently shipped). Audit log retains both updates so we can see the history. |
| Operator cancels via Stop after Step 1c but before Step 2 | PR description is updated, no Jira comment. Lane stays at `implement`. Operator clicks Approve Implementation again — Step 1c is idempotent (audit guard short-circuits), Step 2 runs fresh. Acceptable. |

### API Surface Parity

| Surface | Today | After |
|---|---|---|
| `implementCommentDoc` (`server/jira/adf.ts`) | Hand-rolled comment body | Delegates to `buildImplementationShipNote` |
| `postQaFixComment` (`server/jira/qaFixComment.ts`) | Hand-rolled cycle-N comment body | Delegates to `buildImplementationShipNote` with `cycleNumber: N` |
| `implementComplete.ts` Step 1b → Step 2 path | Direct | Adds Step 1c (`gh pr edit`) between |
| `gh pr edit --body-file` | Not used today | New use; matches existing `gh pr ready` / `gh pr create` invocation patterns |
| Audit actions | `jira.implement_comment_posted`, `pr.marked_ready` | Adds `pr.description_updated`, `pr.description_update_failed` |
| Agent prompt (`workPrompt`) | Free-form structure | Required four sections + optional list |
| New file: `server/jira/shipNote.ts` | does not exist | NEW (`extractShipNoteSections`, `buildImplementationShipNote`) |
| New file: `tests/shipNote.test.ts` | does not exist | NEW |

### Integration Test Scenarios

In `tests/shipNote.test.ts`:

1. **Full happy path** — implementation.md with all 4 required +
   2 optional sections. Renderer output (ADF + markdown) matches
   snapshot. Both surfaces would show the same body.
2. **Missing Test Plan** — `complete: false`; placeholder appears
   in both rendered outputs. Renderer doesn't crash.
3. **Heading variations** — `### Test Plan` (h3) and `## TEST PLAN`
   (caps) both extract correctly.
4. **Misnamed heading** — `## Testing` (close to "Test Plan" but
   not in allowlist) is dropped, parser returns empty testPlan,
   `complete: false`.
5. **Optional sections in order** — `## Files Touched` and
   `## Out of scope` appear after the four required, in source
   order, in both rendered outputs.
6. **Cycle-N heading variant** — `cycleNumber: 2` produces "QA
   fix pushed — round 2" heading.
7. **Empty input** — empty markdown returns all-empty +
   `complete: false`; renderer produces all-placeholder output.

## Acceptance Criteria

### Functional Requirements

- [ ] `ce:work`'s `workPrompt` declares 4 required sections in the
  agent's `implementation.md` output.
- [ ] `extractShipNoteSections` parses the four required + optional
  sections forgivingly (h2/h3, case-insensitive).
- [ ] `buildImplementationShipNote` returns identical content for
  ADF and markdown.
- [ ] `implementCommentDoc` delegates to the shared renderer (cycle
  1) — Jira comment body shows all four sections.
- [ ] `postQaFixComment` delegates to the shared renderer (cycle N>1)
  with the appropriate heading variant.
- [ ] `implementComplete` Step 1c rewrites the PR description with
  the markdown ship-note via `gh pr edit --body-file`.
- [ ] Step 1c is idempotent (audit guard); failures are warn-only.
- [ ] In-flight cards (no Test Plan section) approve cleanly with
  placeholder text.

### Non-Functional Requirements

- [ ] No new external dependencies.
- [ ] No DB schema migrations.
- [ ] No breaking changes to existing endpoints.
- [ ] Bundle size impact: zero (server-side only).
- [ ] Markdown body stays well under GitHub's 65k char limit for
  typical implementations (<5k).

### Quality Gates

- [ ] All existing 77 tests pass (no regression on the cycle
  helpers shipped in Layer B).
- [ ] At least 12 new tests in `tests/shipNote.test.ts` covering
  the seven integration scenarios above.
- [ ] `npm run typecheck`, `npm run build` clean.
- [ ] Manual smoke: take a fresh card through cycle 1, verify
  Jira comment + PR description both render the new ship-note.
- [ ] Manual smoke: trigger a QA-fix cycle, verify cycle-2 comment
  renders with the cycle heading variant.

## Success Metrics

- **QA self-service:** within 30 days of ship, zero "what should I
  test on this PR?" follow-ups from QA to engineering. Verified
  by absence of such Slack threads / Jira comments.
- **Reviewer click-through reduction:** zero "open the
  implementation.md to see what changed" comments in PR reviews.
  Today's pattern.
- **Adoption:** 100% of new implementation cycles produce a
  Jira comment + PR description with all four sections populated
  (zero `complete: false` outcomes for cards built post-deploy).
  Surfaced by the audit log: count `pr.description_updated`
  events vs. count `task.implementation_complete` events — should
  be ~equal.

## Dependencies & Prerequisites

**External:** none new. `gh pr edit` is part of the existing `gh`
CLI we already require.

**Internal:**
- `server/jira/adf.ts` ADF primitives — shipped.
- `server/git/implementComplete.ts` step-machine pattern —
  shipped.
- `audit_log` table — shipped.
- `ghEnv()` helper for `gh` invocations — shipped (re-exported
  in Layer B).

**Blocking:** none.

## Risk Analysis & Mitigation

| # | Risk | Mitigation | Phase |
|---|---|---|---|
| 1 | Agent occasionally drops a required section | Renderer handles via placeholder. Audit `pr.description_updated` payload includes `complete: false` flag so ops can monitor and re-run if drift is observed. | Phase B/C |
| 2 | `gh pr edit` rate-limited | Operator retries Approve Implementation. Audit guard prevents re-edits on success; failure path is warn-only. | Phase E |
| 3 | Heading parser too forgiving and merges sections | Strict allowlist of headings; unrecognised headings dropped. | Phase B |
| 4 | Heading parser too strict and rejects an h3 instead of h2 | Phase B's parser explicitly accepts h2 OR h3 to absorb minor agent stylistic drift. | Phase B |
| 5 | Markdown→ADF conversion produces broken ADF for unusual content (unicode, code blocks inside bullets) | Renderer uses ADF primitive helpers, not raw markdown injection. Test #1 covers code spans inside bullets. v2: more robust converter if observed in production. | Phase C |
| 6 | Cycle-N heading change breaks the QA-fix postQaFixComment audit dedup | The dedup key is `runId + action`, not the comment body. No regression. Test in Phase F. | Phase F |
| 7 | Existing `implementCommentDoc` callers (other than `implementComplete`) | Verified zero callers other than `implementComplete.ts` via grep. Type signature stays compatible. | Phase D |
| 8 | PR description rewrite changes git history view ordering on GitHub | None — PR description edits don't touch the diff or commit history. | n/a |
| 9 | Operator dislikes the new Jira format and wants the old terse one back | Behaviour is committed via the renderer. v2 could add an "ops mode" toggle if pushback materialises; v1 ships with the new format. | Future |

## Resource Requirements

- **Engineering:** ~3 days single-engineer.
- **Testing:** ~half day (folded into Phase G).
- **Infra:** none.
- **Docs:** none new (implementation flow already documented;
  comment in `shipNote.ts` covers the parser semantics).

## Future Considerations

**v2 polish (not in this plan):**
- **Per-section character limits** in the agent prompt (e.g.,
  "Test Plan: 5-15 bullets, each one imperative sentence ≤ 200
  chars"). Tightens consistency.
- **Operator-edit modal** before Approve Implementation that shows
  a preview of the ship-note and lets the operator tweak / add a
  note. Useful for high-stakes PRs; chore for routine ones.
- **Markdown body length truncation** with a "see implementation.md
  for full content" footer when content exceeds 50k chars.
- **Diff-stat in the body** ("changes: 12 files, +340/-42") —
  inferred from git, useful glance.
- **Per-cycle differentiation** beyond just the heading (e.g., a
  "## Changes since round N-1" section that's QA-cycle-specific).

**Compatibility with QA-fix loop:** the shared renderer is the
exact integration point — Phase F demonstrates it. Future cycle
variants (failed-CI loop, post-merge-hotfix, etc.) lift on the
same `cycleNumber` parameter.

## Documentation Plan

| Doc | Change |
|---|---|
| `README.md` | No change — the agent's contract change is a prompt detail; the shipping behaviour is a refinement of existing flow. |
| `docs/install-checklist.md` | No change — no new env var or dep. |
| Code comment in `server/jira/shipNote.ts` | Explains the strict heading allowlist (so future contributors don't relax to "## Tests" silently). |
| Code comment in `server/agents/registry.ts` workPrompt | Inline note pointing at `extractShipNoteSections` so a maintainer changing the prompt sees the consumer. |
| `docs/brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md` | Add "Resolved in plan" link once shipped. |

## Sources & References

### Origin

- **Brainstorm:** [docs/brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md](../brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md). Carries forward all three resolved decisions (agent-emitted Test Plan; standard ship-note contract; identical body for both surfaces) plus the six open-question defaults.

### Internal references

- Today's Jira comment: `server/jira/adf.ts:274` (`implementCommentDoc`)
- Today's section parser: `server/jira/adf.ts:145` (`extractSummary`)
- Today's PR body builder: `server/git/approve.ts:368` (`buildPrBody` — sets the planning-stage body that this plan replaces post-implement)
- `implementComplete` step machine: `server/git/implementComplete.ts:142-200` (Step 1b: `gh pr ready`; Step 2: `postComment`)
- ce:work prompt: `server/agents/registry.ts` `workPrompt` (the contract change lives here)
- Sibling Jira comment files following the same shape:
  - `server/jira/amendComment.ts` (uses `extractSummary`)
  - `server/jira/qaFixComment.ts` (mirror; touched by Phase F)
- `gh pr ready` invocation pattern: `server/git/implementComplete.ts:144`
- `gh pr create` invocation pattern: `server/git/approve.ts:211-227`
- `gh pr list` invocation pattern: `server/git/approveCycle.ts:163`
- ADF primitives: `server/jira/adf.ts` (`heading`, `paragraph`, `bulletList`, `code`, `link`, `rule`, `panel`)
- Audit pattern: `server/auth/audit.ts`

### External references

- GitHub CLI `gh pr edit`: https://cli.github.com/manual/gh_pr_edit (verified — supports `--body-file`).
- Jira ADF spec: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/ (used today by `adf.ts`; no new node types needed).

### Related work

- Brainstorm: [docs/brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md](../brainstorms/2026-05-05-implementation-handoff-improvements-brainstorm.md)
- QA-fix loop plan (touched by Phase F): [docs/plans/2026-05-01-feat-qa-failed-fix-loop-plan.md](2026-05-01-feat-qa-failed-fix-loop-plan.md)
- Card-detail bug cluster plan (sibling, pre-shipped): [docs/plans/2026-05-01-fix-card-detail-bug-cluster-plan.md](2026-05-01-fix-card-detail-bug-cluster-plan.md)
