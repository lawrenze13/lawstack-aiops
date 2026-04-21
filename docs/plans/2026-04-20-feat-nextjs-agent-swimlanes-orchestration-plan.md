---
title: "feat: Build multiportal-ai-ops Next.js swimlane orchestration MVP"
type: feat
status: active
date: 2026-04-20
origin: docs/brainstorms/2026-04-20-nextjs-agent-swimlanes-brainstorm.md
---

# feat: Build multiportal-ai-ops Next.js swimlane orchestration MVP

## Overview

Build a single-tenant Next.js 15 web app that **replaces the existing Slack + n8n + `ticket-worker.sh` flow** with a Trello/Kanban-style swimlane UI for driving Claude Code agents on Jira tickets. One process, one SQLite file, one VPS — sized for a 2–10 person team.

The pipeline is fixed (`Ticket → Branch → Brainstorm → Plan → Review → PR`). Each lane runs a swappable agent (a thin wrapper over `claude -p` with a different prompt + skill hint). Output streams live to the card detail panel via Server-Sent Events; users can chat mid-run via `claude --resume`. Drafts live in SQLite; only on the single `Approve & PR` gate do artifacts get committed to the worktree, pushed, draft-PR'd, and posted as a Jira comment.

**Origin brainstorm:** [docs/brainstorms/2026-04-20-nextjs-agent-swimlanes-brainstorm.md](../brainstorms/2026-04-20-nextjs-agent-swimlanes-brainstorm.md). Key decisions carried forward: full-stack Next.js + SQLite + child_process; auto-advance with one approval gate; Google OAuth restricted to `@multiportal.io`; agent library v1 = `ce:brainstorm` / `ce:plan` / `ce:review`; in-app notifications only; hard cut from Slack on launch day.

## Problem Statement

The current automation flow couples five moving parts: Jira webhook → n8n workflow → SSH → `/home/lawrenzem/bin/ticket-worker.sh` → Slack thread (via `claude-stream-to-slack.sh`). It works, but:

- **Triggering is one-way and opaque.** Slack `@law-automate <ticket>` is the only entry point; users can't see queue state, in-progress runs, or per-lane status.
- **Output is a Slack firehose.** Stream-JSON tool events get individually posted, polluting the channel; meaningful state (cost, lane, artifacts) is buried.
- **Mid-run interaction is brittle.** Today's `ask` mode + `NEEDS_INPUT:` + `ticket-resume.sh` works, but discoverability is zero — only the user who started the run can see the prompt, only by scrolling the thread.
- **Lanes are implicit.** The brainstorm/plan/review phases are jammed into one prompt invocation. There's no way to swap the brainstorm agent independently of the plan agent.
- **No cost guardrails.** A runaway tool loop can burn dollars before anyone notices.
- **Recovery is manual.** A server reboot mid-run silently kills the worktree; no UI surfaces "this stopped, click Resume."

The new app collapses this into one browser tab: card-centric UX, live streaming output, in-app chat, atomic `Approve & PR`, cost caps, and crash recovery — all on the same VPS without adding Redis or moving to serverless.

## Proposed Solution

A single Next.js 15 (App Router, Node runtime) process backed by a single SQLite file (better-sqlite3, WAL). Every lane invocation is a `child_process.spawn('claude', [...])` whose stream-JSON stdout is parsed line-by-line into `messages` rows and fan-out to subscribed SSE clients via an in-process `EventEmitter`. The existing `ticket-worker.sh` engine is **decomposed**: its worktree management, prompt construction, and stream parsing become Node modules (`server/worker/*`), invoked per-lane rather than monolithically.

### Stack (locked from research)

| Concern | Choice |
|---|---|
| Framework | Next.js 15 App Router, Node runtime |
| Auth | Auth.js v5 + Google + Drizzle adapter, `signIn` callback domain check + allow-list table |
| DB | better-sqlite3 + Drizzle ORM, WAL + `synchronous=NORMAL` + `busy_timeout=5000` |
| Streaming | SSE (`ReadableStream` + `EventEmitter`), `Last-Event-ID` replay against `messages(seq)` |
| UI | shadcn/ui (owned components, copied), Tailwind v4, dnd-kit `@dnd-kit/react` |
| Chat / log render | Hand-rolled `EventSource` consumer (skip Vercel AI SDK + @assistant-ui — wrong fit, see Alternatives) |
| Validation | Zod for every API boundary |
| Subprocess | `child_process.spawn` with `stdbuf -oL -eL`, `readline` line events, SIGTERM→5s→SIGKILL |
| External | `gh` CLI for PRs (already shelled), Atlassian Jira REST v3 (fetch) |
| Hosting | Same VPS, behind Caddy (`flush_interval -1` for SSE) |

### Repo

New repository `multiportal-ai-ops`, separate from the Yii2 app. Working dir on VPS: `/var/www/aiops.multiportal.io/`.

## Technical Approach

### Architecture

```
┌─────────────────────────── browser tab ───────────────────────────┐
│  shadcn Board (dnd-kit)   │   Card detail panel                  │
│   ─ lanes / drag cards    │    ─ live event log (EventSource)    │
│                           │    ─ chat box (POST /message)        │
└──────────────┬────────────┴──────────────┬───────────────────────┘
               │ HTTP                       │ SSE (text/event-stream)
┌──────────────┼────────────────────────────┼────────────────────────┐
│  Next.js 15 (Node runtime, single process)                         │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────────┐    │
│  │ App Router │  │ Auth.js v5   │  │ Drizzle / better-sqlite3 │    │
│  │  routes    │  │ (Google)     │  │  (WAL, single instance)  │    │
│  └─────┬──────┘  └──────────────┘  └──────────┬───────────────┘    │
│        │                                       │                   │
│  ┌─────▼────────────┐  ┌──────────────────┐    │                   │
│  │ runRegistry       │  │ runBus           │    │                   │
│  │ Map<runId,Child>  │◄─│ EventEmitter per │◄───┤ messages(seq)    │
│  └─────┬────────────┘  │ runId (fan-out)  │    │ append-only      │
│        │ spawn         └──────────────────┘    └──────────────────┘
│        ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ claude -p --session-id --resume --output-format stream-json  │   │
│  │   --include-partial-messages --verbose                        │   │
│  │   --permission-mode acceptEdits --bare                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│        │ writes to                                                  │
│        ▼                                                            │
│  /var/aiops/worktrees/<task_uuid>/  (git worktree of base repo)    │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ on Approve & PR only
                       git push + gh pr create + Jira comment
```

### Repository layout

```
multiportal-ai-ops/
├── app/
│   ├── (auth)/sign-in/page.tsx
│   ├── (board)/page.tsx                  # default = My Tasks
│   ├── (board)/team/page.tsx             # Team Board toggle
│   ├── (board)/cards/[id]/page.tsx       # detail panel (intercepting route)
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts
│   │   ├── tasks/route.ts                # POST create, GET list
│   │   ├── tasks/[id]/route.ts           # GET, PATCH (lane move), DELETE archive
│   │   ├── tasks/[id]/runs/route.ts      # POST start a run for lane X
│   │   ├── runs/[id]/route.ts            # GET status
│   │   ├── runs/[id]/stream/route.ts     # SSE
│   │   ├── runs/[id]/message/route.ts    # POST chat msg → claude --resume
│   │   ├── runs/[id]/stop/route.ts       # POST SIGTERM
│   │   ├── tasks/[id]/approve/route.ts   # POST commit + push + PR + Jira
│   │   ├── jira/search/route.ts          # JQL passthrough
│   │   ├── jira/issue/[key]/route.ts     # fetch by key
│   │   └── admin/ops/route.ts            # stuck runs, cost/day
│   └── globals.css
├── components/
│   ├── ui/                               # shadcn — owned
│   ├── board/{Board,Lane,Card,LaneHeader}.tsx
│   ├── card-detail/{RunLog,ChatBox,CostBadge,ApproveButton,AgentPicker}.tsx
│   └── notifications/{ToastHost,TabBadge}.tsx
├── server/
│   ├── db/{client.ts,schema.ts,migrate.ts}
│   ├── auth/{config.ts,middleware.ts,domain-allow.ts}
│   ├── jira/{client.ts,adf.ts}
│   ├── git/{worktree.ts,push.ts,pr.ts}
│   ├── worker/
│   │   ├── runRegistry.ts                # Map<runId, RunHandle>
│   │   ├── runBus.ts                     # EventEmitter per runId
│   │   ├── spawnAgent.ts                 # spawn + readline + persist
│   │   ├── streamParser.ts               # stream-JSON event normaliser
│   │   ├── costMeter.ts                  # per-frame usage → $ → cap check
│   │   ├── reconcile.ts                  # boot-time interrupted-run sweep
│   │   └── prompts/{brainstorm.ts,plan.ts,review.ts}
│   ├── agents/{registry.ts,types.ts}     # TS config = source of truth
│   └── lib/{rateLimit.ts,audit.ts,errors.ts}
├── data/
│   └── app.db                             # gitignored
├── drizzle.config.ts
├── next.config.ts
├── components.json                        # shadcn
└── package.json
```

### Data model

```mermaid
erDiagram
    USER ||--o{ TASK : owns
    USER ||--o{ AUDIT_LOG : actor
    TASK ||--o{ RUN : has
    TASK ||--o| WORKTREE : occupies
    TASK }o--|| AGENT_CONFIG : "uses (per lane)"
    RUN  ||--o{ MESSAGE : produces
    RUN  ||--o{ ARTIFACT : drafts
    RUN  }o--|| AGENT_CONFIG : "snapshot at start"
    TASK ||--o| PR_RECORD : "after Approve"
    AUDIT_LOG }o--|| TASK : about
    AUDIT_LOG }o--|| RUN  : about

    USER {
      text id PK
      text email UK
      text name
      text role "admin|member|viewer"
      int  created_at
    }
    TASK {
      text id PK
      text jira_key UK "UNIQUE WHERE status<>'archived'"
      text title
      text description_md
      text owner_id FK
      text status "active|archived"
      text current_lane "ticket|branch|brainstorm|plan|review|pr"
      text current_run_id "nullable, latest non-superseded run for current_lane"
      int  created_at
    }
    RUN {
      text id PK
      text task_id FK
      text lane
      text agent_id "matches agents/registry.ts key"
      text agent_config_snapshot_json
      text claude_session_id
      text status "running|completed|failed|stopped|cost_killed|interrupted"
      text resumed_from_run_id "nullable"
      int  superseded_at "nullable"
      int  cost_usd_micros "store as int micros to avoid float math"
      int  num_turns
      int  last_assistant_seq
      int  last_heartbeat_at
      int  started_at
      int  finished_at
      text killed_reason "nullable"
    }
    MESSAGE {
      int  id PK "autoincrement"
      int  seq "monotonic per run; = SSE event id"
      text run_id FK
      text type "system|assistant|user|stream_event|result|server"
      text payload_json
      int  created_at
    }
    ARTIFACT {
      text id PK
      text run_id FK
      text task_id FK
      text kind "brainstorm|plan|review"
      text filename
      text markdown
      bool is_approved
      bool is_stale "true when an upstream artifact was re-generated"
      text supersedes_id "nullable"
      int  approved_at
      text approved_by
    }
    WORKTREE {
      text path PK "/var/aiops/worktrees/<task_uuid>"
      text task_id UK FK
      text branch
      int  created_at
      int  last_used_at
      text status "live|removed"
    }
    AGENT_CONFIG {
      text id PK "e.g. ce:brainstorm"
      text name
      text prompt_template
      text skill_hint
      text model
      int  max_turns
      text config_hash
    }
    PR_RECORD {
      text task_id PK FK
      text branch
      text commit_sha
      text pr_url
      text jira_comment_id
      text state "drafting|committed|pushed|pr_opened|jira_notified|failed_at_*"
      int  opened_at
    }
    AUDIT_LOG {
      int  id PK
      int  ts
      text actor_user_id FK
      text actor_ip
      text action
      text task_id "nullable"
      text run_id "nullable"
      text payload_json
    }
```

Notes on the model (resolves spec-flow gaps G1–G12):

- **`task.current_run_id` + `run.superseded_at`** answer "which run is the live one for this lane" deterministically (G1).
- **`artifact.supersedes_id` + `is_stale`** track lineage; re-running Brainstorm marks the downstream Plan artifact stale, blocking `Approve & PR` until resolved (G2).
- **`worktree(path PK, task_id UK)`** plus UUID-based paths (`/var/aiops/worktrees/<task_uuid>/`) avoid kebab-case collisions and survive reboot (G4). Path lives on persistent disk, not `/tmp/`.
- **`run.last_heartbeat_at`** updated on every stream-JSON frame; admin ops marks `running` runs without a heartbeat in 90s as "stuck" (G13).
- **`agent_config_snapshot_json`** pins the exact prompt/model used so historical runs are inspectable after the TS config changes (G12).
- **`audit_log`** is append-only at the table level (no `UPDATE`/`DELETE` triggers); never pruned (G11).
- **`PRAGMA foreign_keys=ON`** is mandatory; SQLite defaults to OFF.

### API surface

All routes are App Router Route Handlers under `app/api/*`. All accept JSON, validate with Zod, return JSON. Domain restriction is enforced in `middleware.ts`; per-route role checks via `requireRole()` helper.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/api/tasks` | Create task from `{ jira_key }` (preflight: dedup + fetch Jira summary/desc) | member+ |
| `GET`  | `/api/tasks?owner=me\|all` | Board data | member+ |
| `GET`  | `/api/tasks/:id` | Task + last run per lane + artifacts | viewer+ |
| `PATCH`| `/api/tasks/:id` | Move lane (validates transition graph) | owner / admin |
| `DELETE`| `/api/tasks/:id` | Archive (soft, sets `status=archived`) | owner / admin |
| `POST` | `/api/tasks/:id/runs` | `{ lane, agent_id }` → spawns child, returns `run_id` | owner / admin |
| `GET`  | `/api/runs/:id` | Run row | viewer+ |
| `GET`  | `/api/runs/:id/stream` | **SSE** with `Last-Event-ID` replay | viewer+ |
| `POST` | `/api/runs/:id/message` | `{ text, client_request_id }` → enqueue `claude --resume` | owner / admin (rate-limited 20/min) |
| `POST` | `/api/runs/:id/stop` | SIGTERM the child | owner / admin |
| `POST` | `/api/tasks/:id/approve` | Atomic commit→push→PR→Jira | owner / admin |
| `GET`  | `/api/jira/search?jql=` | Passthrough w/ rate-limit guard | member+ |
| `GET`  | `/api/jira/issue/:key` | Fetch issue summary+desc | member+ |
| `GET`  | `/api/admin/ops` | Stuck runs, cost/day, worktree disk | admin |

### Agent runner (per-lane spawn pipeline)

```
POST /api/tasks/:id/runs { lane, agent_id }
  ├─ requireRole(owner|admin)
  ├─ idempotency: reject duplicate within 10s same task+lane (audit_log dedup)
  ├─ INSERT runs (status='running', session_id=uuid(), agent_config_snapshot_json)
  ├─ UPDATE tasks SET current_run_id, current_lane
  ├─ ensureWorktree(task_id) → /var/aiops/worktrees/<task_uuid>
  ├─ build prompt (per-lane template + brainstorm.md if Plan, etc.)
  └─ spawnAgent(runId, prompt, sessionId, worktreePath)
        ├─ child = spawn('stdbuf', ['-oL','-eL','claude','-p',prompt,
        │     '--session-id', sessionId,
        │     '--output-format','stream-json',
        │     '--include-partial-messages','--verbose',
        │     '--permission-mode','acceptEdits','--bare'],
        │     { cwd: worktreePath, env: minimizedEnv(), stdio:['ignore','pipe','pipe'] })
        ├─ runRegistry.set(runId, { child, stop })
        ├─ readline.createInterface({ input: child.stdout })
        │     .on('line', persistAndEmit)        // ← see streamParser
        ├─ child.on('exit', finalizeRun)
        └─ return { run_id }
```

`persistAndEmit(line)`:

```ts
const ev = streamParser.parse(line);             // safe JSON parse + normalise
const { lastInsertRowid: _ , seq } = db.prepare(
  `INSERT INTO messages(run_id, seq, type, payload_json, created_at)
   VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE run_id=?), ?, ?, ?) RETURNING seq`
).get(runId, runId, ev.type, JSON.stringify(ev.payload), Date.now());
db.prepare(`UPDATE runs SET last_heartbeat_at=? WHERE id=?`).run(Date.now(), runId);
costMeter.observe(runId, ev);                    // may trigger soft warn / hard kill
runBus.for(runId).emit('event', { seq, ...ev });
```

`streamParser` mirrors what `claude-stream-to-slack.sh` does in jq, but in TS — switches on `type ∈ {system, assistant, user, stream_event, result}`, normalises tool_use/tool_result blocks, strips internal artefacts, and surfaces the final `result.total_cost_usd` and `result.num_turns` for `runs` finalisation.

### SSE wire protocol

```
event: <type>            # assistant | tool_use | tool_result | system | result | cost_warn | run_killed | server
id: <messages.seq>
data: { ... normalised payload ... }
\n
```

A keep-alive comment `: ka\n\n` every 15s to defeat Caddy's idle timeout. Headers (per research):

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

`runtime = 'nodejs'` and `dynamic = 'force-dynamic'` are mandatory — Edge cannot spawn, and Next will silently turn the route static otherwise.

### Streaming output pipeline

```
claude stdout (line-buffered via stdbuf)
   → readline 'line' event
   → streamParser (JSON.parse + normalise + drop noise)
   → DB INSERT messages RETURNING seq
   → costMeter.observe (may SIGTERM child if cap)
   → runBus.for(runId).emit('event', payload)
   ⇉ N subscribed SSE handlers each enqueue to their controller
```

On client connect:

```
GET /api/runs/:id/stream  (Last-Event-ID: <last_seen_seq>)
   → SELECT * FROM messages WHERE run_id=? AND seq > ? ORDER BY seq → flush as SSE frames
   → bus.on('event', flush)                  ← attach AFTER replay query
   → on req.signal.abort: bus.off + close
```

Replay-then-attach is the correct order; the inverse races against new INSERTs and drops events.

### Cost tracking and kill switch

`costMeter.observe(runId, ev)` parses `ev.payload.message.usage` from every `assistant` frame (cumulative input/output/cache tokens). Multiply by hard-coded model price table (Sonnet 4.7 today; constant lives in `server/agents/pricing.ts`). Maintain `runs.cost_usd_micros`; on crossing $5 emit `cost_warn` SSE + insert `messages(type='server', payload={kind:'cost_warn'})`. On crossing $15:

```ts
runRegistry.get(runId)?.stop({ reason: 'cost_cap' });
db.run(`UPDATE runs SET status='cost_killed', killed_reason='budget_cap_15usd' WHERE id=?`, runId);
runBus.for(runId).emit('event', { type:'run_killed', payload:{ reason:'cost_cap' } });
```

`stop({ reason })` sends SIGTERM, waits up to 5s for the child to drain its stream-JSON output, then SIGKILL. Worktree is left intact — user can Retry (resumes via `claude --resume` on the same `claude_session_id`) or Swap agent (fresh session).

### Crash recovery (boot reconciler)

In `instrumentation.ts` (Next.js's official boot hook), the `register()` callback runs `server/worker/reconcile.ts`:

```ts
db.transaction(() => {
  for (const run of db.all(`SELECT id FROM runs WHERE status='running'`)) {
    db.run(`UPDATE runs SET status='interrupted',
            killed_reason='server_restart', finished_at=? WHERE id=?`,
            Date.now(), run.id);
    db.run(`INSERT INTO audit_log (...) VALUES (...)`); // 'run.interrupted'
  }
})();
```

The card UI shows interrupted runs with a yellow banner and a single `Resume` action that POSTs to `/api/tasks/:id/runs` with `resume_session_id` from the prior run — creating a new `run` row with `resumed_from_run_id` set. Never auto-resume; user decides (G3).

Orphan PIDs (rare — process group is normally reaped on parent exit) are caught by setting `process.title = 'aiops-claude-<runId>'` at spawn time; reconciler `pkill -f 'aiops-claude-'` for any title not in the registry.

### Worktree management

```ts
// server/git/worktree.ts
const ROOT = '/var/aiops/worktrees';
const BASE_REPO = '/var/www/lawrenze.multiportal.io';   // existing target repo
const BRANCH_PREFIX = 'ai/';

export async function ensureWorktree(taskId: string): Promise<{ path: string; branch: string }> {
  const row = db.get(`SELECT * FROM worktree WHERE task_id=?`, taskId);
  if (row?.status === 'live' && existsSync(row.path)) {
    db.run(`UPDATE worktree SET last_used_at=? WHERE path=?`, Date.now(), row.path);
    return row;
  }
  const task = db.get(`SELECT jira_key FROM tasks WHERE id=?`, taskId);
  const path  = `${ROOT}/${taskId}`;
  const branch= `${BRANCH_PREFIX}${task.jira_key}`;

  // dedup: refuse if remote branch exists with open PR (preflight, see G10)
  await preflightBranch(task.jira_key, branch);

  await execFile('git', ['fetch','origin','main'], { cwd: BASE_REPO });
  await execFile('git', ['worktree','add','-B', branch, path, 'origin/main'], { cwd: BASE_REPO });
  await mkdir(`${path}/docs/brainstorms`, { recursive: true });
  await mkdir(`${path}/docs/plans`, { recursive: true });
  db.run(`INSERT INTO worktree(path, task_id, branch, created_at, last_used_at, status)
          VALUES (?, ?, ?, ?, ?, 'live')
          ON CONFLICT(task_id) DO UPDATE SET path=excluded.path, status='live'`,
         path, taskId, branch, Date.now(), Date.now());
  return { path, branch };
}
```

Daily cron (systemd timer) prunes worktrees with `last_used_at < now - 24h AND task.status IN ('archived','done')`.

### Approve & PR atomic pipeline (resolves G7)

```
POST /api/tasks/:id/approve
  ├─ requireRole(owner|admin) on task
  ├─ Validate every required artifact exists, is_approved=true, is_stale=false
  │   (refuse with 409 if any lane's draft is stale)
  ├─ Acquire per-task lock (in-memory Mutex) — refuse second click with 409
  ├─ TRY — each step persists pr_record.state for resumable retry
  │   1. write artifacts to worktree files; pr_state='drafting'
  │   2. git add + git commit -m '...';                 pr_state='committed' (capture sha)
  │   3. git push -u origin <branch>;                   pr_state='pushed'
  │   4. gh pr create --draft (idempotent: gh pr list --head first); pr_state='pr_opened'
  │   5. POST Jira /comment (ADF body w/ PR url);       pr_state='jira_notified'
  └─ On step failure: pr_state='failed_at_<step>', surface single 'Retry' that resumes from current state
     Jira-comment failure is non-fatal: yellow warning + 'Post manually' button
```

`gh pr create` is wrapped to be idempotent: first `gh pr list --head <branch> --json url --jq '.[0].url'`; if present, treat as success and store URL. This ensures retries don't double-open PRs.

### Auth & permissions

**Auth.js v5** with Google provider. `signIn` callback:

```ts
async signIn({ profile }) {
  if (!profile?.email_verified) return false;
  if (!profile.email?.toLowerCase().endsWith('@multiportal.io')) {
    audit('auth.denied_domain', { email: profile.email });
    return false;
  }
  // optional second gate: explicit allow-list table for off-boarding belt-and-braces
  const allowed = db.get(`SELECT 1 FROM allowed_email WHERE email=? COLLATE NOCASE`, profile.email);
  if (!allowed) { audit('auth.denied_allowlist', { email: profile.email }); return false; }
  return true;
}
```

Three roles (G5):

- **admin** — manage agents (post-MVP UI; for v1 = TS-config edit), view all cards, approve/delete any.
- **member** — create tasks; on own cards: run/chat/retry/swap/approve/archive; view team board read-only.
- **viewer** — read-only.

Default new user: `member`. Role stored in `users.role`; bootstrap with one admin via SQL seed.

### Agent library

`server/agents/registry.ts` is the source of truth at boot:

```ts
export const agents = {
  'ce:brainstorm': {
    name: 'CE Brainstorm',
    lanes: ['brainstorm'],
    model: 'claude-opus-4-7',
    skill_hint: 'compound-engineering:ce:brainstorm',
    promptTemplate: brainstormPrompt,
    max_turns: 30,
  },
  'ce:plan':       { /* ... */ },
  'ce:review':     { /* ... lanes: ['review','plan'] (alternate for Plan) ... */ },
} as const;
```

On boot, registry rows are upserted into the `agent_config` cache table with a `config_hash`. Every `runs` row pins `agent_config_snapshot_json` from this table at start time, so historical runs remain inspectable after edits.

### Implementation phases

#### Phase 1: Foundation (week 1)

- [x] Bootstrap `multiportal-ai-ops` Next.js 15 repo (App Router, TS strict, Tailwind v4)
- [ ] shadcn init, install base components (`button card dialog input label scroll-area separator sheet sonner tabs textarea tooltip dropdown-menu`) — *deferred to Phase 2; bare Tailwind sufficed for the empty-board MVP*
- [x] `server/db/{client,schema,migrate}.ts` — Drizzle schema for all tables, WAL pragmas, migrate-on-boot *(boot moved to lazy-init due to webpack/native-binding constraint; deploy runs `npm run db:migrate`)*
- [x] Auth.js v5 + Google + Drizzle adapter + domain-restricted `signIn` + allow-list table; middleware gates everything except `/api/auth/*` and `/sign-in` *(middleware uses edge-safe split config per Auth.js docs)*
- [x] `server/jira/client.ts` — Basic auth, `searchJql`, `getIssue`, `postComment` (ADF), with rate-limit header logging
- [x] `app/api/jira/{search,issue/[key]}/route.ts` and a minimal `<NewTaskDialog>` that searches by JQL, picks an issue, creates a task
- [x] `instrumentation.ts` with the boot reconciler (no-op for now since no runs exist) *(reconciler lives in `server/worker/lazy-init.ts`; instrumentation.ts kept lean to avoid Edge-bundling Node-native deps)*
- [x] **Deliverable:** sign-in restricted to `@multiportal.io`, task creation from Jira key wired, board renders empty lanes (no agent runs yet)
- [x] **Success criteria:** `npm run build` clean with no env vars, `npm run dev` serves, middleware redirects unauthenticated to `/sign-in`, API routes return 401 JSON for unauthenticated callers, `npm run db:migrate` applies schema

#### Phase 2: Agent runner + SSE (week 2)

**Phase 2A — Minimum runnable agent (landed):**
- [x] `server/worker/{spawnAgent,streamParser,runRegistry,runBus}.ts` *(costMeter deferred to 2B)*
- [x] `server/git/worktree.ts` with preflight + collision guard *(UUID-based path under WORKTREE_ROOT)*
- [x] `app/api/tasks/[id]/runs/route.ts` (POST start), `app/api/runs/[id]/stream/route.ts` *(message + stop deferred to 2B)*
- [x] Per-lane prompt templates extracted from `ticket-worker.sh` *(in `server/agents/registry.ts`)*
- [x] Hand-rolled `useRunStream(runId)` hook + `<RunLog>` *(via `components/card-detail/RunLog.tsx`; ChatBox + CostBadge in 2B)*
- [x] `server/agents/{registry,sync}.ts` — TS source-of-truth + DB cache, snapshot per run
- [x] Card detail page `/cards/[id]` with RunStarter + RunLog
- [x] Board cards click through to detail page

**Phase 2B1 — Control loop (landed):**
- [x] Cost guardrails ($5 warn / $15 hard kill) wired end-to-end *(server/worker/costMeter.ts + agents/pricing.ts; observes `assistant.message.usage` per frame, emits cost_warn/cost_killed server events)*
- [x] `app/api/runs/[id]/stop/route.ts` + Stop button *(SIGTERM→5s→SIGKILL via runRegistry.stop('user'); owner/admin only)*
- [x] Crash-recovery Resume banner *(surfaces interrupted runs with a Resume button that POSTs a new run with resumeSessionId)*
- [x] CostBadge live counter in card detail header *(green → yellow at $5 → red at $15; inline in RunLog)*

**Phase 2B2 — Chat + auto-advance (landed):**
- [x] `app/api/runs/[id]/message/route.ts` + ChatBox UI *(POST spawns fresh `claude --resume <sessionId> -p "<text>"` via startRun with overridePrompt; per-run mutex in `server/worker/chatMutex.ts` serialises concurrent sends)*
- [x] Auto-advance between lanes on `result` event *(server/worker/autoAdvance.ts + dynamic import in finalize(); brainstorm→plan→review; stops at review→pr since pr is not agent-driven)*
- [x] Shared `startRun()` helper *(server/worker/startRun.ts; single spawn path used by user-start, chat, and auto-advance)*

**Phase 2B3 — Deferred (minor):**
- [ ] `ce:review` prompt split (plan-lane variant reads codebase; review-lane variant reads the plan artifact and validates)

- **Deliverable (2A landed):** click "Run Brainstorm" on a card; live tool-use events render in the run log; refresh-resume via Last-Event-ID works
- **Success criteria (2A):** AC-2 (replay) passes; AC-1 (crash recovery) needs 2B's UI banner; AC-5 (cost cap) needs 2B's costMeter; AC-8 (stuck runs) needs 2B's admin ops page

#### Phase 3: Pipeline + Approve & PR (week 3)

**Phase 3A — Artifacts + Approve & PR (landed):**
- [x] Auto-advance between lanes *(shipped in Phase 2B2)*
- [x] Artifact persistence on run completion *(server/worker/persistArtifacts.ts; scans worktree for docs/{brainstorms,plans,reviews}/*.md, upserts artifact rows, marks downstream kinds stale)*
- [x] `<ApproveButton>` + `app/api/tasks/[id]/approve/route.ts` with the step-by-step state machine *(server/git/approve.ts handles drafting→committed→pushed→pr_opened→jira_notified; failed_at_<step> enables retry resuming from that step)*
- [x] `gh pr create` idempotent wrapper *(gh pr list --head checked first; existing PR URL reused)*
- [x] Jira ADF comment poster *(server/jira/client.postComment with prCommentDoc; failure is non-fatal, surfaced as warning for manual posting)*
- [x] Stale-artifact gate on Approve *(blocks when upstream re-ran without regenerating downstream)*
- [x] ArtifactPanel with collapsible markdown preview of each artifact

**Phase 3B — Polish:**
- [x] dnd-kit board with valid-transition guard *(@dnd-kit/react + @dnd-kit/helpers; PATCH /api/tasks/:id gates moves to 'pr' lane on Brainstorm+Plan artifacts; optimistic with snap-back on reject)*
- [x] Toast notifications *(ToastHost mounted in layout.tsx; RunLog fires on end/cost-warn/cost-kill, ApproveButton fires on approve success/failure; document.title "(N) …" badge when tab is hidden)*
- [ ] Swap-agent UI to pick a different agent for a lane on retry
- [ ] `ce:review` prompt split (plan-lane variant vs review-lane variant)

- **Deliverable (3A landed):** create task → auto-advance lanes → ArtifactPanel shows produced files → click Approve & PR → commit + push + draft PR + Jira comment all run → card header shows "✓ PR opened → view"
- **Success criteria (3A):** AC-3 (Approve atomicity with retry from failed step), AC-9 (stale gate), AC-11 (PR idempotency) pass

#### Phase 4: Hardening + cutover (week 4)

**Phase 4A — Code/config landed:**
- [x] `/admin/ops` page *(app/admin/ops/page.tsx; admin-role gated; stuck runs (status=running + no heartbeat in 90s), failed runs last 24h, cost by day, audit log last 50, worktree disk via `du`, per-run Kill button via POST /api/admin/kill-run)*
- [x] Audit log writer wired into state-changing routes *(task.created, task.archived, task.lane_changed, run.started_request/started/stopped/finalized/interrupted, artifact.persisted, approve.completed, jira.transitioned/skipped/failed, chat.rate_limited, admin.kill_run — comprehensive)*
- [x] Rate limiting on `/api/runs/:id/message` *(20/min/user/run, sliding window in server/lib/rateLimit.ts; 429 + Retry-After header; ChatBox surfaces via toast)*
- [x] Nightly cron *(server/cron/nightly.ts — prunes messages > 90d, removes archived+old worktrees, nulls orphan heartbeats, wal_checkpoint(TRUNCATE) Sundays; runnable via `npm run cron:nightly`; systemd timer example in docs/deploy.md)*
- [x] Caddy site config *(documented in docs/deploy.md with `flush_interval -1` + `read_timeout 0` for /api/runs/*/stream)*
- [x] systemd unit *(documented in docs/deploy.md with `KillMode=mixed`, `ExecStartPre=npm run db:migrate`, `Restart=on-failure`)*

**Phase 4B — Still to do (process + dark-launch gate):**
- [ ] `DARK_LAUNCH=true` env guard that short-circuits outbound calls (postComment, transitionIssueToName, gh pr create) for dual-run period
- [ ] **Dark-launch (days 1–7):** dual-write against real Jira webhook traffic, no outbound from aiops
- [ ] **Cut-over day:** disable n8n outbound; enable aiops outbound; monitor 48h
- [ ] **Decommission day +14:** archive `ticket-worker.sh` + `ticket-resume.sh` + `claude-stream-to-slack.sh` to `/home/lawrenzem/bin/_archive/`; delete n8n workflows
- **Success criteria:** Slack bot retired ≤14 days post-launch; AC-6, AC-7, AC-10, AC-12 pass; success metrics met for 1 week.

#### Phase 5: Implementation (post-PR, `ce:work` agent) — deferred to post-MVP

Today's pipeline ends at "draft PR opened with Brainstorm + Plan + Review docs." The human then writes the actual code. Phase 5 extends the pipeline so the agent can start (or complete) the implementation, opening new commits on the same branch, with a structured pause-for-human-clarification loop.

**Motivation**: once the Plan has cleared Review (verdict READY) and been approved, the next expensive step is just "do what the Plan says." That's mechanical code writing on a known-grounded plan — a natural next agent lane. The human role shifts from "write the code" to "answer agent questions + review the final PR."

**Scope**
- New **Implementation** state on a task after `Approve & PR` succeeds. UI-wise it can be either:
  - A new "Implement" lane after "PR" (making the lane list: `ticket → branch → brainstorm → plan → review → pr → implement → done`), OR
  - An action button on the existing "PR" lane that kicks off the implement run. Lean toward option 2 so the board doesn't grow another column.
- New agent: **`ce:work`**, registered in `server/agents/registry.ts`. Uses the `compound-engineering:ce:work` skill. Runs inside the same worktree with the same `claude --session-id <uuid>` primitives as prior lanes.
- `ce:work` reads the approved Plan (and Review notes) and implements step-by-step, committing to the feature branch `ai/<JIRA-KEY>` as it goes. Each commit pushes automatically so the PR updates in real time.
- **NEEDS_INPUT pause-and-resume** pattern (mirror of `ticket-worker.sh:168–184` + `ticket-resume.sh`). When `ce:work` encounters ambiguity — a design decision, a missing credential, a scope call — it pauses with a structured marker. Our stream parser detects it, sets `run.status='awaiting_input'`, and surfaces the question prominently to the user.
  - Detection: agent's final assistant message starts with `NEEDS_INPUT:` or emits a structured `{ type: 'needs_input', question }` event.
  - UI:
    - Yellow banner above the log: *"Agent is waiting on you:"* + the question rendered as markdown.
    - Toast on the card owner: *"Implementation paused — needs input."*
    - Tab title badge already flips to "(1) …" (reuses existing behavior).
    - Chat box becomes the answer mechanism — user types the response, Send → fresh `claude --resume <sessionId> -p "<answer>"` subprocess, agent continues.
  - New run status: `awaiting_input` (distinct from `running` so UI + reconciler don't treat it as live-streaming or interrupted).
- **Auto-advance** from PR → Implement is off by default. User clicks "▶ Implement" after they've reviewed the PR docs and are happy with the plan. (Auto-advance would surprise stakeholders; PR review is a human moment.)
- **Cost caps** — `ce:work` runs are longer + more expensive than planning agents. Raise the soft warn to $10 and hard kill to $30 for this agent specifically, configurable per-agent in the registry. (The existing `costMeter` already reads per-run; just need per-agent overrides.)
- **Completion signal** — when the agent finishes cleanly with code committed + PR updated, it writes a `docs/implementation/<key>-implementation.md` artifact summarising what changed (scope of each commit, test additions, manual-verification-needed list). This becomes the final PR comment added to Jira.

**Success criteria (Phase 5)**
- [ ] AC-17: After Approve & PR, clicking "▶ Implement" starts a `ce:work` run; code commits push to the feature branch within 30s of each logical unit.
- [ ] AC-18: When `ce:work` emits `NEEDS_INPUT:<question>`, the card shows a yellow *"Agent is waiting on you"* banner with the question rendered as markdown within 5s. A toast fires on the card owner. The run's status is `awaiting_input`, not `running`.
- [ ] AC-19: User answers via ChatBox; a new `claude --resume` subprocess spawns within 2s; previous conversation state is preserved.
- [ ] AC-20: Cost cap at $30 hard-kills the `ce:work` run; worktree and any already-pushed commits are preserved.
- [ ] AC-21: On clean completion, a new `implementation-summary` artifact is produced and optionally posted as a follow-up Jira comment.

**Deferred from this plan** — the pause/resume infrastructure largely exists already (session IDs, `--resume`, ChatBox, toast). What's net-new is the `awaiting_input` status, the banner component, and the `ce:work` agent config. Expect ~1–2 sessions to land once the rest of Phase 4 is in prod and stable.

## Alternative Approaches Considered

| Alternative | Why rejected |
|---|---|
| Vercel serverless Next.js | Hard 60-second function timeout; agent runs routinely exceed 2 min. Brainstorm explicitly rejected. |
| BullMQ + Redis worker | Overkill at 2–10 users; adds Redis + worker process to operate. Brainstorm explicitly rejected. |
| Postgres instead of SQLite | No upside at this scale; SQLite WAL handles 80k inserts/sec, our ceiling is ~50/sec. Migrate later if multi-host. |
| Vercel AI SDK `useChat` | Wire format is the AI SDK UI Message Stream — we'd transcode our existing stream-JSON into it. Hand-roll EventSource is ~50 LOC and matches the engine we already have. (Research item #7.) |
| `@assistant-ui/react` | Assumes message-centric chat UX; ours is a run log (tool calls, diffs, cost meter, stop button). Build with shadcn primitives. (Research item #8.) |
| WebSockets instead of SSE | Half-duplex SSE + POST is the 2026 default for AI chat; auto-reconnect with `Last-Event-ID` is free; survives proxies; HTTP/2 multiplexes cheaply. WebSockets only win for high-frequency push (>1Hz collab cursors). |
| `@octokit/rest` for PR creation | We're already shelling for Claude; one more `gh pr create` keeps the dependency surface flat. Octokit is the right call only if we need fine-grained PR-state queries. |
| Bubblewrap / chroot the Claude subprocess | The threat model is "our team running our agents on our repo." Minimised env + audit log gives 95% of the value. Bubblewrap is the documented escalation path if the threat model changes. |
| Goroutine sidecar in Go | Splits context across two languages for no perf gain. |
| Continue using `ticket-worker.sh` as-is, just add a UI in front | Misses the lane decomposition; lanes are the headline UX win. Engine refactor is the work. |

## System-Wide Impact

### Interaction graph

A user clicking "Run Brainstorm" triggers:

1. `POST /api/tasks/:id/runs` (Next route handler)
2. → `requireRole()` (auth.js session lookup; SQLite read)
3. → idempotency check (audit_log read)
4. → `db.transaction()` inserting `runs`, updating `tasks.current_run_id`/`current_lane` (SQLite write, single-writer serialised)
5. → `audit('run.started', ...)` (SQLite append)
6. → `ensureWorktree(taskId)` (SQLite read; if not present: `git fetch` + `git worktree add` + `mkdir`)
7. → `spawnAgent(runId, prompt, sessionId, worktreePath)` (`child_process.spawn`)
8. → `runRegistry.set(runId, handle)` (in-process Map)
9. → `readline` attached to child stdout
10. → returns `{ run_id }` to client; client opens `EventSource('/api/runs/:id/stream')`

Each Claude stdout line then triggers (deep chain):

11. `streamParser.parse(line)` → `db.transaction()` insert into `messages` (returns `seq`) + `runs.last_heartbeat_at` update
12. → `costMeter.observe()` (may insert `messages(type='server', cost_warn)`, may call `runHandle.stop()`)
13. → `runBus.for(runId).emit('event', payload)` → N SSE handlers each `controller.enqueue()` (per-tab fan-out)
14. → on `result` event: finalise `runs`, on auto-advance lanes — re-enter step 1 for the next lane

On `result` for lane = PR: nothing auto-happens; user must click `Approve & PR`, which kicks off the 5-step state machine documented above.

### Error & failure propagation

- **Spawn ENOENT (`claude` binary missing)**: `child.on('error')` fires; `run.status='failed', killed_reason='spawn_error'`; SSE emits `run_killed` w/ reason; user sees red banner with "Check server install."
- **Stream-JSON parse error**: caught in `streamParser`; logged to `messages(type='server', kind='parse_error', raw_line)`; run continues. Three parse errors in a row → mark run failed.
- **DB write fails (disk full, locked > busy_timeout)**: surface as 5xx to whichever caller (route handler, parser); the parser path tries again on next line; if persistent, manual ops.
- **Jira API 5xx during task creation**: degraded-mode flag `task.jira_synced=false`; retry on Branch lane entry.
- **Push fails on Approve**: `pr_state='failed_at_push'`; user clicks Retry; idempotent.
- **Cost cap trips mid-tool-call**: SIGTERM → 5s grace → SIGKILL; worktree intact; `run.status='cost_killed'`; user can Retry (resume) or Swap.

Retry-strategy alignment: every retry path re-uses the same `claude_session_id` for "Retry same agent" and creates a fresh one for "Swap agent." No two retry strategies fight: there's exactly one `runRegistry` slot per `run_id`, and a new `run` row is created for each retry.

### State lifecycle risks

- **Worktree present, no run, no DB row**: orphan from a crashed creation. Daily pruner sweeps based on `worktree.status`.
- **DB row says `running`, no PID, no child in registry**: caught by boot reconciler; marked `interrupted`. Without the reconciler, this row would block the lane forever.
- **Artifact persisted, never approved, task archived**: dropped on `tasks.status='archived'` archival cascade; PR_record absent.
- **Push succeeded, PR creation failed**: branch on origin, no PR. Idempotent retry resumes; if user gives up, we have a dangling branch — worth a daily "branches without PR > 24h" admin alert (post-MVP).

### API surface parity

Every action a user can take in the UI must also be doable via API (agent-native parity):

- Create task = `POST /api/tasks` with `{ jira_key }`
- Start lane run = `POST /api/tasks/:id/runs` with `{ lane, agent_id }`
- Send chat message = `POST /api/runs/:id/message` with `{ text, client_request_id }`
- Stop = `POST /api/runs/:id/stop`
- Approve & PR = `POST /api/tasks/:id/approve`
- Watch = `GET /api/runs/:id/stream`

This means a CLI script, a future MCP tool, or another Claude Code agent can drive the system end-to-end without the UI.

### Integration test scenarios

(Cross-layer scenarios that unit tests with mocks would never catch.)

1. **Refresh during streaming.** Start a run, wait ~3s for ~50 events, hard-refresh the browser. Confirm `EventSource` reconnects, sends `Last-Event-ID`, replays the missed seqs in order, then resumes live without dropping or duplicating events.
2. **Kill during tool-call.** Start a run, wait until a Bash tool_use frame appears, click Stop. Confirm SIGTERM is sent, `result` event eventually arrives or grace times out and SIGKILL fires, `run.status='stopped'`, worktree files (if any partial) are intact.
3. **Server restart with active run.** Start a run, `systemctl restart multiportal-ai-ops`. Confirm card flips to yellow `Interrupted` within 30s, no zombie PIDs, `Resume` button creates a new run resuming the prior session.
4. **Approve & PR with simulated push failure.** Pre-create a remote branch with diverged commits to force push to fail. Click Approve & PR. Confirm `pr_state='failed_at_push'`, no PR created, single `Retry` button visible, after fixing the conflict and clicking Retry the flow resumes from `committed` state.
5. **Two tabs, two messages.** Open same card in two browsers; both POST a chat message within 50ms. Confirm both messages are persisted in `seq` order, both tabs see both messages via SSE, Claude receives them in order via the per-run PQueue, no race-condition double-send to `claude --resume`.

## Acceptance Criteria

### Functional requirements

- [ ] **AC-1 (crash recovery, G3):** After `systemctl restart` during an active run, the card shows `Interrupted` within 30s and offers a `Resume` action that spawns a new child process using the persisted `claude_session_id`. No auto-resume.
- [ ] **AC-2 (replay, G6 / E1):** Two browser tabs on the same card both see every new `messages` row in `seq` order; after a 30-second network interruption on one tab, the SSE reconnect using `Last-Event-ID` replays missed events, no drops or dupes.
- [ ] **AC-3 (Approve atomicity, G7):** On any step failure during `Approve & PR`, the card shows the failed step name and a single `Retry` action that resumes from the persisted `pr_state`; no duplicate PRs, no duplicate Jira comments.
- [ ] **AC-4 (worktree uniqueness, G4 / G9):** Two concurrent task creations for the same `jira_key` resolve to one task row; the existing card is surfaced for the second request within one HTTP round-trip.
- [ ] **AC-5 (cost cap, G8):** A run killed by cost cap leaves the worktree intact and the card in `failed` state with `killed_reason='budget_cap_15usd'`; Retry resumes the same Claude session.
- [ ] **AC-6 (permissions, G5):** Only the card owner or an admin can click `Approve & PR`, archive, or swap agent; attempts by other authenticated users return 403 and write an `audit_log` row.
- [ ] **AC-7 (auth, hard cut):** Signing in with a non-`@multiportal.io` email is rejected at the `signIn` callback and logged as `auth.denied_domain`; no `users` row is created. Verified `email_verified===true`.
- [ ] **AC-8 (stuck runs, G13):** Admin ops page lists any run with `status='running' AND last_heartbeat_at < now()-90s` as "stuck" with a kill button.
- [ ] **AC-9 (artifact lineage, G2):** A `brainstorm.md` regenerated after `plan.md` exists marks `plan.md` as `is_stale=true`; `Approve & PR` is blocked until Plan is re-run or user explicitly confirms "keep stale."
- [ ] **AC-10 (rate limit):** A user POSTing >20 chat messages in any 60s window per run receives 429 with `Retry-After`; UI shows a "slow down" toast.
- [ ] **AC-11 (PR idempotency):** `gh pr create` is preceded by `gh pr list --head <branch>`; if a PR already exists, the existing URL is recorded and no new PR opens.
- [ ] **AC-12 (audit log, G11):** Every state-changing API call writes one `audit_log` row including actor, action, task/run ids, and a compact payload; rows are append-only at the table level.
- [ ] **AC-13 (lane-transition validation, G10):** Drag-dropping a card to a non-adjacent lane returns 409 from `PATCH /api/tasks/:id`; the dnd-kit handler snaps the card back. Move-to menu offers only legal destinations.
- [ ] **AC-14 (Jira ADF):** PR comment is posted as ADF (`type:doc, version:1, content[paragraph]`); confirmed visible in Jira UI; failure is non-fatal with a manual-post fallback.
- [ ] **AC-15 (artifact files):** Approved artifacts written to `docs/brainstorms/<jira_key>-brainstorm.md` and `docs/plans/<jira_key>-plan.md` in the worktree before commit; commit message format: `docs(<key>): AI <kind>(s) — <agent_id>`.
- [ ] **AC-16 (concurrent chat, G6):** Per-run PQueue serialises chat messages so `claude --resume` is invoked one at a time; concurrent `Stop` requests after the first 200 return 409.

**Phase 5 (Implementation agent, deferred):**
- [ ] **AC-17 (implement kick-off):** After Approve & PR, clicking "▶ Implement" starts a `ce:work` run; code commits push to `ai/<key>` within 30s of each logical unit.
- [ ] **AC-18 (NEEDS_INPUT surface):** When `ce:work` emits a `NEEDS_INPUT:<question>` marker, the card shows a yellow banner + toast within 5s; run status becomes `awaiting_input` (not `running`/`interrupted`).
- [ ] **AC-19 (NEEDS_INPUT resume):** User answers via ChatBox; fresh `claude --resume` subprocess spawns within 2s; full conversation context preserved.
- [ ] **AC-20 (implement cost cap):** Hard kill at $30 (raised from standard $15); worktree + already-pushed commits preserved.
- [ ] **AC-21 (implementation summary):** On clean completion, `docs/implementation/<key>-implementation.md` artifact produced summarising commits + test changes + manual-verify list; optional Jira follow-up comment.

### Non-functional requirements

- [ ] First contentful paint of `My Tasks` board < 1s on a warm cache (single VPS, ≤50 cards)
- [ ] SSE event end-to-end latency (Claude stdout → browser) < 250ms p50, < 750ms p95
- [ ] No connection drops on a 10-minute run behind Caddy with default config plus `flush_interval -1`
- [ ] All API responses validated by Zod; reject unknown fields
- [ ] Writes to `runs`/`messages` survive `kill -9` of the Next.js process (WAL recovery)
- [ ] No `process.env` is spread into the spawned `claude` env — only the explicit allowlist (`PATH`, `HOME=worktreeDir`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, `JIRA_*`)

### Quality gates

- [ ] TypeScript strict mode clean; no `any` in `server/worker/*`
- [ ] All Route Handlers wrapped in a `withErrorHandler()` that maps thrown `AppError` subtypes to JSON 4xx/5xx
- [ ] `npm run build` clean; `next.config.ts` includes `serverExternalPackages: ['better-sqlite3']`
- [ ] Integration tests for the 5 scenarios listed in **System-Wide Impact > Integration Test Scenarios**
- [ ] One smoke test that spawns a real `claude` process with a 1-turn prompt and asserts a `result` SSE event arrives

## Success Metrics

(From brainstorm — restated as measurable.)

| Metric | Target | Measurement |
|---|---|---|
| Time from "create from Jira key" to draft PR link, single browser tab | < 5 min p95 | `runs.finished_at - tasks.created_at` aggregated |
| Concurrent users without worktree collision | 3 simultaneous on different tickets | manual test on launch day; `worktree` table unique constraint enforced |
| Slack path decommission window | ≤ 14 days post-launch | `_archive/` move date in git |
| Operating cost (Claude + VPS) | within current monthly budget | sum `runs.cost_usd_micros` per month + Hetzner invoice |
| Failed-run rate | < 10% of runs | `count(runs WHERE status IN ('failed','cost_killed'))/count(runs)` |
| p95 SSE event latency | < 750ms | client-instrumented `Date.now() - payload.created_at` |

## Dependencies & Prerequisites

- Node.js 20+ on the VPS (already present at `/home/lawrenzem/.nvm/versions/node/v20.20.2/bin`)
- `claude` CLI on PATH (already present)
- `gh` CLI authenticated with a fine-grained PAT scoped `Contents: rw` + `PRs: rw` for the target repo
- `git` 2.40+ for `git worktree add -B`
- Atlassian API token for the Jira workspace (env: `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BASE_URL`)
- Google Cloud project with OAuth client (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`)
- Caddy site block updated with `flush_interval -1` for `/api/runs/*/stream`
- systemd unit for `multiportal-ai-ops.service` with `KillMode=mixed`, `Restart=on-failure`, `Environment=` for the secret bundle, `WorkingDirectory=/var/www/aiops.multiportal.io`
- Persistent disk path `/var/aiops/worktrees/` owned by the service user, excluded from systemd-tmpfiles cleanup

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Caddy buffers SSE → events arrive in chunks | Medium | UX feels broken | `flush_interval -1` + `X-Accel-Buffering: no`; smoke-test on staging first |
| Server crash mid-run leaves orphan child | Low | Wasted $ + zombie | systemd `KillMode=mixed` + boot reconciler + `process.title` PID sweep |
| Cost cap miscalculates → budget overrun | Medium | $ | Hard-coded model price table, tested against `result.total_cost_usd` reconciliation; alarm if `result.cost > computed.cost * 1.1` |
| Claude CLI flag changes break stream-JSON parsing | Low | Runs all break | Pin Claude CLI version in deploy; integration smoke test asserts event shape; fallback parse keeps unknown event types as `type='unknown', payload=raw` so UI shows "(?)" rather than crash |
| Two devs both click Approve simultaneously | Low | Two PRs / two Jira comments | Per-task in-memory Mutex + `gh pr list` idempotency check + Jira comment idempotency by content hash |
| SQLite write contention under load | Very low at this scale | Slow API | WAL + 5s busy_timeout + batched inserts in 50ms window; ceiling well above expected load |
| Hard-cut migration breaks team's day | Medium | Productivity hit | 7-day dark-launch period + single-toggle rollback + Loom + pinned Slack message |
| Auth.js v5 + Drizzle adapter version mismatch | Low | Sign-in broken | Lock both packages; smoke test in CI |
| Worktree disk fills `/var/aiops/` | Low | Disk full | Daily pruner + `du -sh` on admin ops + alert at 80% disk |
| Permission-mode acceptEdits → Claude does something destructive in worktree | Low | Bad commit | Confined to worktree CWD; pre-Approve diff visible in UI; user reviews before clicking Approve & PR |

## Resource Requirements

- **People:** 1 engineer for 4 weeks; 1 reviewer (Lawrence/Matthew) for design + cutover support
- **Infra:** Existing Hetzner VPS; ~+200MB disk for app; worktree disk usage ~50–500MB per active task (cleaned daily)
- **External services:** Existing Jira workspace + Google OAuth project + GitHub PAT — no new SaaS
- **Estimated Claude spend:** Already captured in current ticket-worker baseline; expect ±0% (same agents, same prompts, lane-decomposition slightly increases turns but stricter cost caps offset)

## Future Considerations

(Out of v1; flagged for after launch.)

- Admin UI for editing `agent_config` rows (currently TS-config only)
- Drag-to-trigger lane custom workflows (per-team transition graphs)
- Per-stage approval gates (currently single gate before PR)
- Bring-your-own-agent marketplace
- Multi-repo support (currently hard-coded to `BASE_REPO`)
- Bubblewrap sandboxing of the spawned child if threat model changes
- Migration to Postgres + multi-host once team grows past ~20 users
- Webhook receivers for Jira state changes (close ticket on PR merge)
- "Amend PR" — allow re-running an agent and force-pushing to the existing branch
- Slack notifications for run-completion (post-cutover, pull-based, opt-in)

## Documentation Plan

- `README.md` — quick start, architecture diagram, env vars, deploy notes
- `docs/runbook.md` — restart procedure, "stuck run" diagnosis, worktree cleanup, manual cost-cap reset
- `docs/agents.md` — how to add a new agent in `server/agents/registry.ts`
- `docs/migration.md` — the dark-launch + cutover checklist, with the n8n toggle locations
- This plan stays in `docs/plans/` as the canonical implementation reference
- Inline JSDoc on every exported function in `server/worker/*` and `server/git/*` (the load-bearing modules)

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-04-20-nextjs-agent-swimlanes-brainstorm.md](../brainstorms/2026-04-20-nextjs-agent-swimlanes-brainstorm.md)
  - Key decisions carried forward: full-stack Next.js + SQLite + child_process; fixed 6-lane pipeline with swappable agents; auto-advance with single `Approve & PR` gate; drafts in DB / final in git on approval; Google OAuth restricted to `@multiportal.io`; `ce:brainstorm` / `ce:plan` / `ce:review` agent library v1; in-app notifications only; cost guardrails $5 warn / $15 hard kill; hard cut from Slack on launch.

### Internal references (existing engine to evolve)

- `/home/lawrenzem/bin/ticket-worker.sh` — current monolithic engine; the worktree, prompt, stream-parse, commit, push, PR logic decomposes into `server/worker/*` and `server/git/*`
  - Stream-JSON invocation pattern: `ticket-worker.sh:242-249`
  - `NEEDS_INPUT:` pause/resume protocol: `ticket-worker.sh:268-308` and `ticket-resume.sh:126-143`
  - Session-file persistence shape: `ticket-worker.sh:278-296`
  - Final-result cost extraction: `ticket-worker.sh:319-322`
- `/home/lawrenzem/bin/ticket-resume.sh` — `claude --resume <session_id>` pattern; mirrors what `POST /api/runs/:id/message` does in Node
- `/home/lawrenzem/bin/claude-stream-to-slack.sh` — stream-JSON event normalisation; ports to `server/worker/streamParser.ts` (lines 61–91 = the per-tool descriptor map)
- Target repo for worktrees: `/var/www/lawrenze.multiportal.io` (current `REPO` env in worker)

### External references (current as of 2026)

- Next.js 15 streaming + Route Handlers — https://nextjs.org/docs/app/guides/streaming
- Auth.js v5 + Drizzle adapter — https://authjs.dev/getting-started/adapters/drizzle
- Auth.js domain restriction — https://authjs.dev/guides/restricting-user-access
- better-sqlite3 performance docs — https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
- Drizzle ORM SQLite — https://orm.drizzle.team/docs/get-started-sqlite
- shadcn/ui Tailwind v4 install — https://ui.shadcn.com/docs/tailwind-v4
- dnd-kit React — https://dndkit.com/react/guides/multiple-sortable-lists
- AI SDK stream protocol (reference for what we deliberately don't use) — https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- Atlassian Jira REST v3 — https://developer.atlassian.com/cloud/jira/platform/rest/v3/
- Atlassian rate-limit headers (March 2026 changes) — https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- gh CLI `pr create` — https://cli.github.com/manual/gh_pr_create
- Claude CLI headless reference — https://code.claude.com/docs/en/headless
- Claude Agent SDK streaming — https://code.claude.com/docs/en/agent-sdk/streaming-output
- Node child_process — https://nodejs.org/api/child_process.html
- MDN SSE + Last-Event-ID — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- Caddy `flush_interval` for SSE — https://caddyserver.com/docs/json/apps/http/servers/routes/handle/reverse_proxy/flush_interval/
- SQLite WAL — https://www.sqlite.org/wal.html
- SSE vs WebSockets in 2026 — https://websocket.org/comparisons/sse/

### Related work

- Existing `ticket-worker.sh` flow on this VPS — full feature-parity target
- Compound-engineering `ce:brainstorm`, `ce:plan`, `ce:review` skills (used as the agent library's prompt templates) — installed at `/home/lawrenzem/.claude/plugins/marketplaces/compound-engineering-plugin/plugins/compound-engineering/commands/ce/`
