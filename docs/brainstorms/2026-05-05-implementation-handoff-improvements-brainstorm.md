---
title: Implementation handoff improvements — richer Jira comment + PR description rewrite
status: active
date: 2026-05-05
topic: implementation-handoff-improvements
---

# Implementation handoff improvements

When `Approve Implementation` fires today, two artifacts go out for
the human handoff: a Jira "Implementation complete" comment and the
GitHub PR description. Both are thinner than they should be:

- **Jira comment** — PR link, ticket title, commits-bulleted, intro
  paragraph + section TOC from `implementation.md`. No file list, no
  test plan. QA reads this comment as the source of truth for what
  to test, but it doesn't actually tell them what to test.
- **PR description** — set ONCE during `approveAndPr` to the
  planning-stage bullets ("review the brainstorm/plan/review docs").
  Never updated when implementation lands — so the PR describes the
  *plan*, not the *built thing*, on the surface developers reach
  for first.

Result: QA testers and PR reviewers both have to dig — into the diff,
into the implementation.md file, into the agent's session log — to
figure out what shipped and how to verify it. This brainstorm
captures the design for a richer handoff that puts that information
where the readers actually look.

## What we're building

Three changes that converge on a single ship-note shape:

### 1. Tighten the `ce:work` prompt contract

`docs/implementation/<key>-implementation.md` is currently
free-form prose with whatever sections the agent decides to emit.
The new contract makes four sections **required**:

- `## Summary` — one-paragraph "what was built" (already produced
  today as the unmarked intro)
- `## User-visible changes` — what the operator/end-user sees
  differently (UI changes, new buttons, new toasts, behavioural
  shifts). One bullet per visible change.
- `## Risk areas` — what could break or regress, ranked by
  blast-radius. Names specific files/flows the QA tester should
  poke at. The agent has the most context here — it just touched
  the code.
- `## Test Plan` — concrete scenarios QA should verify, written as
  short imperative steps ("Open card detail; click Approve & PR;
  verify lane moves to pr"). One scenario per acceptance-criterion
  from the plan, plus any edge cases the agent caught while
  building.

Anything else (Files Touched, Out-of-scope, Rollback notes, etc.)
stays optional.

### 2. New shared renderer for the ship-note

A single `buildImplementationShipNote(input)` function (likely in
`server/jira/adf.ts` next to the existing `implementCommentDoc`)
parses the implementation.md sections via an extended
`extractSummary` / new `extractShipNoteSections` helper and
produces a structured rendering that BOTH the Jira comment and
the GitHub PR description use, byte-identical.

The shape: heading + summary + each of the four required sections +
commits-bulleted + PR link footer. Same shape, same body, both
surfaces.

### 3. PR description rewrite at Approve Implementation time

`implementComplete.ts` Step 1b currently runs `gh pr ready` to
flip the PR out of draft state. We add a new step (1c, before
the Jira comment in Step 2) that runs `gh pr edit --body` with
the shared ship-note as the new description. The planning-stage
bullets that `approveAndPr` seeded get replaced — the PR
description now reflects what was BUILT instead of what was
PLANNED.

The planning artifacts are still committed in the repo
(`docs/brainstorms/`, `docs/plans/`, `docs/reviews/`); reviewers
who want them can find them via the `## Planning docs` footer
pointer the new renderer adds at the bottom — single line, link
to the docs directory in the PR's tree view.

## Why this approach

**Agent-emitted Test Plan** (resolved Q1) — the agent has the most
context about what they actually built and the edge cases worth
poking at. A plan-derived Test Plan would inherit drift from
plans written days before the code landed; an operator-typed Test
Plan turns a fast click into a typing chore.

**Standard ship-note over minimal or comprehensive** (resolved Q2)
— Summary + User-visible + Risk + Test Plan covers what a code
reviewer + QA tester actually need (context, blast radius,
verification) without bloating the handoff. Files-touched +
rollback notes can be inferred from the diff/git log on the PR
side; QA doesn't need them in the Jira comment.

**Identical content for Jira and PR** (resolved Q3) — single
renderer; one source of truth; no divergence drift. The Jira
reader and the GitHub reader see the same words; if a section is
unclear in one, fixing it fixes both.

**Replace, not append, on PR description** — the PR description
should describe what the PR IS, not what was planned. The
planning docs are still in the repo for reviewers who want them;
a footer pointer keeps them discoverable. Append-then-replace-
later would just create a stale planning bullet that nobody
trusts.

## Key decisions

| Decision | Choice |
|---|---|
| Source of "what to test" | Agent-emitted; new `## Test Plan` required section in `implementation.md` |
| Required sections in `implementation.md` | Summary + User-visible changes + Risk areas + Test Plan |
| Renderer | Single shared `buildImplementationShipNote` used by both surfaces |
| Jira comment vs PR description content | Identical body; both run through the same renderer |
| PR description action at Approve Implementation | Replace (not append) the planning-stage body |
| Where the planning docs go | Stay in `docs/brainstorms/` etc.; a footer line in the new PR description points there |
| Where the renderer lives | `server/jira/adf.ts` next to existing comment helpers |
| Where the section parser lives | Extend `extractSummary` or new `extractShipNoteSections` in `adf.ts` |
| Section enforcement | Agent prompt makes them required; renderer falls back to "section not provided" placeholder if missing (defer hard-fail to v2) |
| Existing in-flight cards | Graceful degrade — if `implementation.md` lacks a section, the renderer notes it instead of failing the Approve step |
| Action name in audit | Keep existing `jira.implement_comment_posted`; new `pr.description_updated` for the PR-edit step |

## Resolved questions

1. **Where does the "what needs to be tested" content come from?**
   → Agent-emitted, via a required `## Test Plan` section in
   `implementation.md`. The `ce:work` prompt grows by ~6 lines to
   declare the contract.

2. **What sections must `implementation.md` contain?**
   → Standard ship-note: Summary + User-visible changes + Risk
   areas + Test Plan. Other sections are optional.

3. **How do the Jira comment and PR description differ?**
   → They don't — single shared renderer produces identical
   content. The PR description gets a redundant PR link line, but
   that's harmless and keeps the renderer simple.

## Open questions

These are real but solvable in plan phase, not blockers for
brainstorm sign-off.

1. **QA-fix comment symmetry.** Today `postQaFixComment` (cycle
   N>1) has a different shape than `implementCommentDoc` (cycle 1).
   Should the QA-fix comment ALSO use the new ship-note renderer?
   QA reads both; consistency is high-value, low-cost. Default:
   yes, share the renderer with a "cycle N" header variant.

2. **Section-missing behaviour.** If the agent emits an
   implementation.md without a `## Test Plan` section (forgot, or
   stylistic disagreement), what does the renderer do?
   - **(a) Render with placeholder:** "_Test Plan section not
     provided by the agent — see the diff._" Soft failure, ship
     proceeds.
   - **(b) Block Approve Implementation:** hard fail in
     `implementComplete` Step 2 with a clear "Re-run ce:work to
     get a Test Plan section" error.
   - Default for v1: (a). Hard-fail invites lock-out incidents
     when the prompt drifts; soft-fail surfaces the gap visibly
     without blocking the human handoff.

3. **Section parser robustness.** Markdown headings are easy to
   parse but the agent might emit `### Test Plan` (h3 instead of
   h2), `## Testing` (different name), or no heading. How
   forgiving is the parser?
   - Default: case-insensitive substring match on the heading
     text (`/test plan/i`, `/risk(s)?( areas?)?/i`, etc.). Plus
     accept h2 OR h3. Anything stricter is brittle.

4. **Existing in-flight cards** at the moment of deploy. Cards
   that are between `ce:work` finishing and the operator clicking
   Approve Implementation will have an old-shape `implementation.md`
   with no Test Plan section. Open-question-2 default (placeholder)
   handles this gracefully — no migration needed.

5. **What about the `Planning docs` footer link?** GitHub PR
   descriptions support relative links to repo files (e.g.,
   `[plan](docs/plans/PROJ-123-plan.md)`). Cleanest. But Jira ADF
   doesn't render those — Jira readers see the bare path. The
   footer can be Jira-omitted, or rendered as a plain "See
   `docs/plans/PROJ-123-plan.md` in the PR" line. Decide in plan.

6. **Custom sections from the agent.** If the agent emits an
   optional section like `## Migration notes` or `## Out of scope`,
   should the renderer include it? Default: yes, append any
   recognised optional sections after the four required ones in
   the order they appear. Unrecognised headings are dropped (we
   don't want random agent thoughts ending up in the QA handoff).

## Success criteria

- After `Approve Implementation` fires, the Jira "Implementation
  complete" comment contains four labeled sections: Summary,
  User-visible changes, Risk areas, Test Plan. Each populated
  from the agent's emitted `implementation.md`.
- The GitHub PR description contains the SAME four sections, byte-
  identical to the Jira comment, with a footer pointer to
  `docs/plans/<key>-plan.md`.
- A QA tester reading the Jira comment can identify (a) what's new
  in the product, (b) what's risky, (c) which scenarios to test —
  without opening the PR, the diff, or the implementation.md
  artifact.
- Existing in-flight cards (with old-shape `implementation.md`)
  approve cleanly, with placeholder text where sections are
  missing.
- New cards built post-deploy ALWAYS have all four sections (the
  prompt makes them required; the agent is consistent enough that
  this should hold > 95%).
- The `ce:work` prompt change is < 10 lines.

## Scope boundaries (explicitly out)

- **Hard-fail Approve Implementation on missing sections.** v1
  uses placeholder text. Revisit if drift is observed in
  production.
- **Section-content validation.** No checks like "Test Plan must
  have ≥ 3 scenarios" or "Risk areas must reference at least one
  file." The renderer trusts the agent to write substantive
  content; the prompt asks for it.
- **Operator override / pre-Approve modal.** No editable preview;
  the operator clicks Approve and the comment + description go
  out as the agent emitted them. (Could add later if drift
  becomes a problem.)
- **Files-touched / diff-stat in the body.** Inferable from the
  PR's diff tab; not duplicated in the comment.
- **Rollback procedure section.** Optional; nice for high-risk
  changes but not required by the contract.
- **Multi-language support.** Comments are English-only.
- **Markdown rendering inside the Jira comment.** ADF supports
  bullets, headings, code spans, panels, links — not full
  markdown. The renderer translates the agent's markdown to ADF;
  fancy markdown (tables, images) gets simplified.
- **Per-cycle differentiation.** v1's renderer doesn't
  distinguish cycle 1 ("first ship") vs. cycle N ("QA fix"). Open
  question 1 will resolve whether the QA-fix comment uses the
  same shape with a "Cycle N" header variant.

## References

- Today's Jira comment: `server/jira/adf.ts:274` (`implementCommentDoc`)
- Today's PR body builder: `server/git/approve.ts:368` (`buildPrBody`)
- Today's section parser: `server/jira/adf.ts:145`
  (`extractSummary` — produces the intro + section TOC the existing
  comment uses; needs extension)
- Approve Implementation flow:
  `server/git/implementComplete.ts:142-200` (Step 1b: `gh pr
  ready`; Step 2: `postComment` with implementCommentDoc)
- `ce:work` prompt: `server/agents/registry.ts` (the `workPrompt`
  function — the contract change lives here)
- QA-fix sibling comment:
  `server/jira/qaFixComment.ts:33` (`postQaFixComment` — symmetry
  question)
- Closest existing analogue: `server/jira/amendComment.ts`
  (`postAmendmentComment` — uses `extractSummary` similarly,
  produces a structured Jira comment)

## Estimated scope

| Slice | Effort |
|---|---|
| `ce:work` prompt contract change (4 required sections) | 0.5 day |
| `extractShipNoteSections` parser in `adf.ts` | 0.5 day |
| `buildImplementationShipNote` shared renderer | 0.5 day |
| `implementComplete.ts` Step 1c (`gh pr edit --body`) | 0.5 day |
| Wire into `implementCommentDoc` (replace existing body) | 0.25 day |
| QA-fix comment symmetry (open Q1) | 0.25 day if yes |
| Tests + smoke + section-missing graceful degrade | 0.5 day |

**~2.5–3 days of focused work.** No DB schema, no new dependencies.
The only external API touch is the new `gh pr edit --body` call,
which is idempotent (running it twice with the same body is a
no-op).
