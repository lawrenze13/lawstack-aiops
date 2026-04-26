---
title: Customizable Workflows & Custom Agents
status: active
date: 2026-04-23
last_revised: 2026-04-24
topic: customizable-workflows
---

# Customizable Workflows & Custom Agents

Turn LawStack/aiops from an opinionated CE-shaped orchestrator into a
configurable agent pipeline where operators define their own lanes,
their own agents (prompt + model), and save named workflows they pick
from at ticket creation.

## 2026-04-24 update — v1 scope cut

A follow-up brainstorm session pruned this design to a smaller MVP.
The full vision below is preserved as the **v2 target**. **v1 ships
the smallest end-to-end slice**:

| Aspect | v1 (next ship) | v2 (vision below) |
|---|---|---|
| Number of workflows | **One** instance-wide workflow | Unlimited named workflows |
| Custom agents | **No** — agent pool stays code-defined | Yes — operator creates agents in /admin/agents |
| Where edited | **/admin/settings** (added section) | Three new admin screens |
| Ticket assignment | All tickets use the one workflow | Workflow dropdown on ticket creation |
| Multi-repo | **Single-repo (BASE_REPO)** unchanged | Repo registry + per-repo workflows |
| Rails (always present) | `ticket → branch → … → pr → done` | Same |
| Open (operator-customizable) | `brainstorm`, `plan`, `review`, `implement` (lane add/remove/reorder, agent swap, prompt context append) | Same shape, more pages |
| Required-with-fixed-position | `implement` (must produce PR) — agent swappable | Same |

**Why narrow further:** the user explicitly chose "single-repo, single
workflow" and "DB-backed admin UI" over the more ambitious branches.
The v2 features (named workflows, custom agents, repo registry) all
build cleanly on top of v1's data model — v1 is not a dead-end, it's
the first vertical slice. Estimated v1 effort: **3–5 days** vs. v2's
~10.

**v1 acceptance criteria — workflow editor:**
- Admin opens `/admin/settings`, sees a "Workflow" section with the
  four open lanes listed in order.
- Can drag-reorder, add a new lane (picking from the existing agent
  pool of 8), remove a lane, swap which agent runs in each lane,
  append free-text prompt context per lane.
- Cannot remove `implement`, cannot remove rails, cannot break the
  state machine.
- Saving updates `LANES` everywhere (Board, dashboard, run dispatch)
  on next page load — no restart.
- New tickets immediately use the new workflow; in-flight tickets
  are NOT migrated (their `lane` value persists; if their current
  lane was removed, the operator manually advances them via existing
  card actions).

**v1 acceptance criteria — agent management:**
- New `/admin/agents` page (separate from `/admin/settings`) lists
  the 8 code-defined agents in a table: id, label, model, cost caps.
- Click row → drawer or dedicated subpage with a friendly per-agent
  editor for the three operator-tunable fields: **model** (select),
  **costWarnUsd / costKillUsd** (numbers), **promptAppend** (textarea).
- Base prompt + tools + maxTurns + permission mode stay code-defined
  (read-only on the page, shown for context).
- "Create agent" button is **NOT** present in v1 — defers prompt-template
  evaluation, tool-sandbox, and validation work to v2.
- Existing `AGENT_OVERRIDES` JSON blob auto-imports into the per-agent
  rows on first boot after this ships (no operator action needed).
- Workflow editor's lane→agent dropdown shows the same 8 agents,
  filtered by `agent.lanes` (e.g. `ce:brainstorm` only available for
  the brainstorm lane).
- Admin-only for both `/admin/agents` and the workflow section.

The v2 sections below stay as the long-term plan and reference for
what NOT to over-engineer in v1.

---

## Strategic tension (read this first)

Today the product identity is **"Compound Engineering for Jira."**
Everything downstream — 8 fixed lanes, 4 coded agents, artifact
filenames, status transitions — assumes that shape.

The requested feature dissolves that identity. The app becomes a
**generic agent pipeline platform** whose default workflow happens to
be CE. That's not a bug; it's a deliberate repositioning. Worth
naming now so we don't pretend the original scope is intact.

**What we gain:** different ticket types can use different pipelines;
experimenting with new agents stops requiring a git PR; operator
autonomy scales with their ambition.

**What we give up:** every new release that ships prompt changes or
lane order to stock CE must now reason about users who've customised
their workflows. The opinionated "this is the pipeline, don't
negotiate" pitch softens.

**We're accepting the trade.** CE stays as a frozen built-in
workflow; custom workflows are additive.

## What we're building

### 1. Workflows

A **workflow** is a named, ordered list of lanes plus some metadata
(description, author, created-at). Workflows are stored in the DB,
editable via UI. The **built-in CE workflow** is seeded on first
install as a read-only system workflow (operators can clone it to
get an editable copy, they can't edit it directly — protects the
upgrade path when we ship CE prompt changes).

Tickets pick their workflow at creation time (dropdown in the
NewTaskDialog). A ticket is locked to its workflow for its lifetime;
lane transitions only use lanes defined in that workflow.

### 2. Lanes

Each lane in a workflow has:

- **id** (unique within workflow)
- **label** (display name)
- **agent_id** (which agent fires when this lane runs)
- **order** (integer, determines position in the pipeline)
- **description** (what this lane is for, shown in header tooltip)
- **artifact_kind** (e.g., `brainstorm`, `plan`, `review`, `implementation`, `custom`)
- **required** (boolean — if false, runs on this lane can be skipped)

Lanes advance **linearly**: when a run completes on lane N, the card
auto-advances to lane N+1. No branches, no DAG, no conditional
routing. That's a deliberate YAGNI — we can add failure-branch
semantics later if enough users ask (see § Future).

Existing CE verdict gating (Review blocks PR on P2_BLOCKER) stays
built into the Review lane's agent logic, not the lane shape itself.

### 3. Agents (global pool)

An **agent** is:

- **id** (e.g., `ce:work`, `custom:db-migration-reviewer`)
- **label**
- **model** (select from the available Claude models)
- **prompt_template** (string; placeholders: `{{jira_key}}`,
  `{{ticket_summary}}`, `{{branch}}`, `{{prior_artifacts}}`)
- **maxTurns** (integer)
- **costWarnUsd / costKillUsd** (numbers)
- **source** (`builtin` or `custom` — builtins are read-only)

**Tools are NOT user-configurable** in v1. Every custom agent
inherits the same tool set (Read, Write, Edit, Bash, Grep, Glob,
Task) that current CE agents have. Sandboxing custom tool allowlists
is explicitly deferred (see § Future).

**Global pool:** agents live independently of workflows. Create
`custom:design-review` once, use it from any workflow's Review lane.
Workflows reference agents by id.

### 4. Prompt template

Custom prompts use a simple mustache-style template:

```
You are {{agent.label}}. The ticket is {{jira_key}}: {{ticket_summary}}.
Read the prior artifacts from {{prior_artifacts}}.
Do the following work:
<operator-written prose>
```

Placeholders are evaluated server-side from the runtime context
(same context the built-in `buildPrompt` functions receive today).
Missing placeholders render as empty strings — no errors thrown,
documented in a help panel next to the textarea.

### 5. UI surfaces (three new screens)

- **`/admin/workflows`** — list of workflows; create / clone /
  delete / reorder lanes per workflow; assign agents to lanes.
- **`/admin/agents`** — list of agents; create / edit / delete
  custom agents; builtins shown greyed-out with a "clone to edit"
  button.
- **NewTaskDialog** — add a "Workflow" dropdown (defaults to
  "Compound Engineering"). Single new control; minimal disruption to
  existing create flow.

Admins manage both screens. Members see their workflow on each
ticket but can't edit.

## Why this approach

**Unlimited saved workflows with built-in CE frozen** gives
maximum user flexibility while keeping a safe upgrade path. If we
ship a tuned Review prompt in v1.2, stock-CE users get it
automatically; customised-clone users keep theirs until they
re-clone.

**Linear order + no tool allowlisting** is the right YAGNI slice. The
hard problems in "agent platforms" are conditional routing,
tool-sandbox, and prompt sandboxing — none are blocking first users
and all can be added later without breaking the schema.

**Global agent pool** matches operator mental model. You don't think
"I have 3 copies of ce:work, one per workflow" — you think "I have
ce:work and it runs in whichever workflows I wire it into."

**Ticket locks its workflow** is a simplification that saves us from
migration hell. Half-complete tickets whose workflow changes
mid-flight are a rabbit hole (what if the new workflow doesn't have
the lane the ticket is currently in?). Locking ticket → workflow at
creation removes the whole class of bugs.

## Key decisions

| Decision | Choice |
|---|---|
| Workflows | Unlimited, DB-stored, admin-managed |
| Built-in CE | Frozen system workflow, cloneable |
| Agent creation | Prompt + model only (no tool allowlisting) |
| Lane transitions | Linear order only |
| Workflow assignment | Chosen at ticket creation, then locked |
| Agent pool | Global, referenced by id from workflows |
| Prompt system | Mustache-style placeholders, server-evaluated |
| UI scope | 3 new admin pages (workflows, agents, edit-lane) |
| Permissions | Admin-only for workflow/agent management |

## Resolved questions

1. **Workflow deletion with live tickets** → **soft-delete**.
   Workflow flagged `deleted_at`, invisible in NewTask dropdown; in-flight
   tickets continue on the stale copy until they finish.
2. **Built-in CE agents** → **stay coded + DB mirror row**. `registry.ts`
   keeps `buildPrompt` logic; the `agents` table has a row per built-in
   with `source='builtin'`, `editable=false`, so `/admin/agents` lists
   them uniformly with customs. Future CE updates = no migration.
3. **Artifact filenames for custom lanes** → **operator-defined template
   with a sensible default**. Each lane has an `artifact_path_template`
   string (mustache). Default: `docs/{{lane_id}}/{{jira_key}}-{{lane_id}}.md`.
4. **Existing tickets migration** → on the first migrate with this
   feature, every task row gets `workflow_id = built-in-ce-default`.
   Becomes a one-liner in the 0003 migration.

## Deferred questions (future)

- **Prompt validation** — reject nonsense prompts? Likely not; the
  cost cap is the safety net. Revisit if users complain.
- **Lane-level env requirements** — per-lane required-setting
  warnings (e.g., PR needs `BASE_REPO`). Useful but deferrable to a
  later polish pass.

## Success criteria

- Admin can create a new workflow with 3 lanes, wire up a custom
  agent, and run a ticket through it end-to-end in one sitting
  without touching code.
- The built-in CE workflow continues to work exactly as today for
  any ticket created with it.
- Workflow + agent changes are auditable (who edited, when, what
  was the prompt before).
- Deleting a workflow that has active tickets fails with a clear
  error OR soft-deletes safely (per open Q#2).
- `/admin/ops` dashboard reflects custom workflows (stuck-run
  detection, cost meter) without special-casing.

## Scope boundaries (explicitly out)

- **Tool allowlisting per agent.** Every agent gets the same
  built-in tool set. Sandboxing per-agent is a separate multi-week
  initiative.
- **Conditional routing / branching.** Lanes are linear. Review
  failure bouncing back to Plan stays hardcoded in the Review
  agent's logic, not the workflow shape.
- **Multi-tenant workflows.** Workflows are instance-wide, not
  per-team or per-user.
- **Jira-field auto-selection.** Ticket creator picks workflow
  manually. Auto-selection based on Jira labels / issue types is
  future work.
- **Visual workflow editor.** Admin UI is list + form based, not a
  drag-and-drop canvas. YAGNI until we have 20+ lane types.
- **Prompt version history / diffs.** Audit log records changes but
  no in-UI diff view.
- **Exporting / importing workflows.** No JSON export for sharing
  across instances. Could be added in a follow-up with ~2 days.

## References

- Agent registry today: `server/agents/registry.ts`
- Current lane model: `components/board/Board.tsx:15` (LANES const)
- Existing settings substrate: `server/lib/config.ts`
  (getConfig / setConfig, AGENT_OVERRIDES JSON blob)
- Settings tabs UI pattern (matches the proposed admin screens):
  `components/admin/SettingsTabs.tsx`
- Tasks table: `server/db/schema.ts` (needs a `workflow_id` column)

## Estimated scope

Rough estimate, based on the decisions above:

- Data model: `workflows`, `lanes`, `agents` tables + task migration → 1 day
- Admin UI (3 screens): workflows, agents, lane editor → 3 days
- Runtime: getAgent resolves from DB + prompt template eval → 2 days
- Board dynamic lane rendering (replaces hardcoded LANES array) → 1 day
- NewTaskDialog workflow dropdown + ticket→workflow lock → 0.5 day
- Artifact persistence with custom filename templates → 1 day
- Audit log + history → 0.5 day
- Tests + docs + migration for existing tickets → 1 day

**~10 days of focused work.** Could ship an MVP at 6 days by cutting
the admin UI down to "edit via JSON blob in /admin/settings" for v1,
then building proper screens in v2.
