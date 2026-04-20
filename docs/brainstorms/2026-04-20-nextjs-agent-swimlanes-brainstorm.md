---
ticket: (internal)
date: 2026-04-20
status: draft
topic: Next.js swimlane UI for AI ticket automation
---

# Next.js Agent Swimlanes — Brainstorm

## What We're Building

A Next.js web app that replaces the current Slack + n8n ticket-automation flow with a **Trello/Kanban-style swimlane UI** for driving AI agents on Jira tickets.

### Core flow

1. User creates a **Task** card — either by pulling a Jira ticket (search/pick) or entering a new ticket key.
2. App creates a git **worktree + branch** (`ai/<ticket>`) on the same server.
3. The card moves through a **fixed pipeline of lanes**, each powered by a swappable agent:
   - `Ticket` → `Branch` → `Brainstorm` → `Plan` → `PR`
4. Each lane's agent runs on the card when it enters the lane, **streams output live** to the card's detail view, and **auto-advances** to the next lane on completion.
5. User can watch progress in real time, interrupt, or chat with the agent mid-run.
6. On completion: draft PR is opened, card lands in `PR` lane.

### Agent library

Each lane has a default agent, but users can pick alternates from a library:

- `Brainstorm` lane: `ce:brainstorm` (default), `short-brainstorm`, `requirements-first`
- `Plan` lane: `ce:plan` (default), `minimal-plan`, `review-then-plan`
- `PR` lane: `draft-pr` (default), `pr-with-tests`, `pr-with-reviewers`

Agents are thin wrappers over Claude CLI invocations with different prompts + skills. Implemented as TypeScript config files that map `agent_id → {prompt_template, skill_hint, model, max_turns}`.

### Real-time interaction

- **Streaming output:** Server-Sent Events (SSE) from Next.js API route. Each agent's stdout + tool-use events stream to the card detail panel as they happen.
- **Chat mid-run:** Detail panel has a text box. Messages inject into Claude's session (via `--resume <session-id>`) — same mechanism as our current Phase 2 `ask` mode. Claude can also pause and ask questions.

## Why This Approach

Full-stack Next.js + SQLite + node `child_process`.

- **One process, one DB file, one restart** — matches the "single-server, small team, replace Slack" decision.
- **Reuses the existing `ticket-worker.sh` engine** — git worktree + Claude CLI + `gh pr create` are already proven. Next.js just shells out to it with env vars.
- **SQLite is enough for <10 users** — schema: `tasks`, `runs`, `messages`, `agents`, `users`. No Redis, no Postgres.
- **SSE for streaming** — simpler than WebSockets for unidirectional server→browser streams, and already built into Next.js App Router with `ReadableStream`.
- **NextAuth for team auth** — Google OAuth over your multiportal.io workspace.
- **Reuses current infra** — runs on `dev.multiportal.io` behind Caddy. No new hosting, no tunnels.

Rejected: Vercel serverless (can't run 2-minute git worktree jobs), BullMQ (overkill for team-sized concurrency), Go sidecar (splits context unnecessarily).

## Key Decisions

**Scope**: Replace Slack + n8n entirely. Hard cut on launch day — no parallel operation window. Launch readiness bar is therefore high.

**Architecture**: Full-stack Next.js 15 (App Router) + SQLite (better-sqlite3) + child_process spawning `ticket-worker.sh`. Runs on same server as worker. UI built with **shadcn/ui** (owned components, Radix primitives, Tailwind).

**Repo**: New repo `multiportal-ai-ops`. Separate from the Yii2 app.

**Pipeline**: Fixed lanes (`Ticket → Branch → Brainstorm → Plan → Review → PR`). Each lane accepts a swappable agent from a library.

**Advancement**: Auto-advance BETWEEN stages, ONE gate before finalizing:
- Brainstorm → Plan (auto)
- Plan → Review state (auto; output held as draft in DB)
- `Approve & PR` button (manual) → commits drafts to git, pushes branch, opens draft PR, posts PR link to Jira

**Output storage**: Drafts live in SQLite as markdown `artifacts` tied to the run. Only on `Approve & PR` does the content get committed to the worktree and pushed.

**Users**: Small team (2-10). NextAuth with Google OAuth, restricted to `@multiportal.io` email domain. Admins can create new agents; all users can use them.

**Boards**: Personal board (`My Tasks`) is the default view. Team Board toggle shows everyone's cards with avatars. Cards are owned by creator but visible to all.

**Real-time**: SSE for streaming agent output. Browser subscribes to `/api/runs/<id>/stream` per open card. Chat messages POST to `/api/runs/<id>/message` and inject into the Claude session via `claude --resume <session_id> -p "<msg>"` — same mechanism as the current Phase 2 `ask` mode.

**Notifications**: In-app only for MVP (toast + badge on tab title). No email, no push, no Slack DM.

**Jira integration**: On `PR` lane success, auto-post PR URL as a comment on the Jira ticket via Atlassian REST API.

**Dedup**: If the ticket already has an active run or a remote branch `ai/<ticket>`, the "New Task" flow surfaces the existing card instead of starting a new one.

**Agent library at launch**:
- `ce:brainstorm` — default on Brainstorm lane
- `ce:plan` — default on Plan lane
- `ce:review` — alternate for Plan lane (reviews existing code before planning)

**Failure handling**: Card stays in its current lane, marked `failed` with red state. Detail view shows error log. User clicks `Retry (same agent)` or `Swap agent` to pick a different agent for that lane. No auto-rollback.

**Cost guardrails**: Running cost displayed per card. Warning at $5, hard-stop at $15 per run. Admin-configurable thresholds.

**Data model**: `task(id, jira_key, title, description_md, created_by, created_at, owner_id)`, `run(id, task_id, lane, agent_id, claude_session_id, status, started_at, finished_at, cost_usd, turns)`, `message(id, run_id, role, content, created_at)`, `artifact(id, run_id, kind, filename, markdown, is_approved, approved_at, approved_by)`, `agent(id, name, prompt_template, skill_hint, model)`, `user(id, email, name, role)`.

**Where state lives**: SQLite for all structured data + drafts. Worktrees stay on disk at `/tmp/worktree-<ticket>`. Only final (approved) artifacts committed to git. No blob store.

**Worktree lifecycle**: Created on `Branch` lane entry, kept alive across Brainstorm/Plan/Review lanes so `claude --resume` can re-open it, removed on successful PR or manual archive. Daily cron prunes orphans older than 24h.

**Config**: Jira/GitHub/Anthropic credentials in env vars loaded at boot. Agents configurable via a TypeScript config module checked into the repo (for MVP — admin-editable UI is post-MVP).

## Resolved Questions

1. **Auth provider** — Google OAuth via NextAuth. Restrict to `@multiportal.io` domain.
2. **Repo location** — new repo `multiportal-ai-ops`. Clean separation from the Yii2 app.
3. **Slack transition** — hard cut. Retire Slack bot on launch day.
4. **Concurrent runs on same ticket** — block. Surface the existing active run instead of spawning a new one.
5. **Card persistence on refresh** — agent keeps running server-side. Browser just reconnects SSE.
6. **Output storage** — drafts in DB (SQLite), finalized artifacts committed to git only on approval.
7. **Gate model** — auto-advance between lanes; ONE gate (`Approve & PR`) before finalization.
8. **Agent library v1** — `ce:brainstorm`, `ce:plan`, `ce:review`. No quick-draft for MVP.
9. **Failure handling** — card stays in lane, marked failed, Retry / Swap agent options.
10. **Cost guardrails** — soft warning at $5, hard stop at $15 per run (admin-configurable).
11. **Jira closure** — auto-post PR URL as a comment when PR is opened.
12. **Notifications** — in-app only (toast + tab badge). No email / push / Slack DM.
13. **Boards** — personal view default; shared team view via toggle.
14. **Chat modality** — chat panel in card detail, messages injected via `claude --resume`.

## Open Questions (defer to plan phase)

1. **Archive/retention** — proposal: 90 days for `runs` + `messages`, nightly prune. Confirm in plan.
2. **Worktree retention** — keep alive across lanes for session resume; prune orphans > 24h via cron.
3. **Admin UI for agents** — out of MVP (TS config file only). Revisit after launch.
4. **UI stack** — **shadcn/ui** (components copied into repo, built on Radix), **Tailwind CSS** (styling), **dnd-kit** (swimlane drag-and-drop), **Vercel AI SDK** (SSE streaming helpers for Claude output + chat), **Zod** (request/response validation). Assistant/chat components via `@assistant-ui/react` if it fits; otherwise roll our own shadcn-styled.

## Scope boundaries

### In scope for MVP
- Team shared swimlane board + personal view toggle
- Task creation from Jira key (search, paste, or "new ticket first")
- Fixed 6-lane pipeline (`Ticket → Branch → Brainstorm → Plan → Review → PR`)
- Swappable agent per lane from a 3-agent library (`ce:brainstorm`, `ce:plan`, `ce:review`)
- Live streaming output (SSE) + chat mid-run (`claude --resume`)
- Auto-advance between stages, one `Approve & PR` gate at the end
- Drafts in DB, finalized artifacts committed to git on approval
- Draft PR creation + auto-comment to Jira
- Auth: Google OAuth restricted to `@multiportal.io`
- Cost tracking per run + soft/hard cost caps
- In-app notifications only (toast + title badge)
- Run history (last 90 days, nightly prune)
- Failure states with Retry / Swap agent

### Explicitly NOT in MVP
- Multi-tenant / external users
- Custom workflow builder (drag-drop lanes/transitions)
- Per-stage approval gates (only one gate before PR)
- Agent marketplace / bring-your-own-agent UI
- Mobile app (responsive web is fine)
- Slack bot coexistence — hard cut
- Email / desktop push notifications
- Advanced analytics dashboards
- Billing / quotas
- Admin UI for agent editing (TS config file for MVP)
- External API for third-party integrations

## Success criteria

MVP is a success if:
- A team member can create a task from a Jira key, watch an agent run end-to-end, and land on a draft PR link — all from one browser tab in under 5 minutes.
- Three teammates can work simultaneously on different tasks without stepping on each other's worktrees.
- The Slack path is fully decommissioned within 2 weeks of launch.
- Operating cost (Claude + server) stays within current budget.

## Next step

Run `/ce:plan` to produce a concrete implementation plan: Next.js project skeleton, DB schema, API routes, SSE wiring, agent runner, and the migration plan for retiring the Slack/n8n flow.
