---
title: Sidebar Navigation with Dashboard, Profile, Notifications
type: feat
status: active
date: 2026-04-22
origin: docs/brainstorms/2026-04-22-sidebar-and-nav-upgrade-brainstorm.md
---

# Sidebar Navigation with Dashboard, Profile, Notifications

## Overview

Evolve the orchestrator's thin top-nav into a proper operator console.
Everything except the swimlane board (`/`, `/team`, `/cards/[id]`) gets
a 240px left sidebar with primary navigation; the board keeps its
current horizontally-dense chrome. Introduces three new surfaces —
`/dashboard` (ops/cost/throughput/activity tiles), `/profile` (per-user
prefs + sign-out), notifications tray — plus a mobile drawer so the
whole app is usable at 375px.

## Problem Statement

The current top-nav is `My Tasks | Team Board | ⚙ Admin` + a theme
toggle. Three concrete pains:

1. **No room to grow.** Adding Dashboard, Profile, reports, etc.
   would crowd the header and push it past a comfortable width.
2. **Admin UX bolted on.** `/admin/ops` and `/admin/settings` are
   real surfaces but the nav treats them as an afterthought.
3. **Per-user settings have nowhere to live.** Theme is cookies,
   personal agent defaults don't exist, notification preferences
   don't exist. There's no account surface at all.
4. **Mobile is unusable.** The board renders but there's no
   responsive strategy.

## Proposed Solution

**Hybrid navigation**, per brainstorm decision:

- **Board pages** (`/`, `/team`, `/cards/[id]`) — keep current top-nav;
  add a "Dashboard →" link for discoverability. No sidebar.
- **Every other page** — 240px fixed left sidebar with LawStack brand,
  primary nav, admin-only section, notifications bell, footer (theme
  toggle + user chip + sign-out).
- **Mobile (<1024px)** — sidebar converts to off-canvas drawer opened
  by a burger button in a compact top bar.
- **Phone (<768px)** — board keeps horizontal scroll; dashboard tiles
  stack to 1-col; card detail drops the sidebar entirely.

Three new pages:

- **`/dashboard`** — 2×2 tile grid: ops health, cost meter, throughput,
  activity feed. Scoped to the viewer (admin = all, member = self).
- **`/profile`** — identity (name, email, theme, sign-out), personal
  agent defaults, notification preferences.
- **Notifications tray** (panel, not a page) — bell icon with unread
  badge; opens a 400px right-side panel listing recent events from
  `audit_log` scoped to the viewer's tasks.

## Technical Approach

### Architecture

**Next.js App Router route groups** are the mechanism. Route groups
don't affect URLs but let each group have its own layout:

```
app/
  layout.tsx                    # root (theme, fonts) — UNCHANGED
  (board)/                      # top-nav surfaces, no sidebar
    layout.tsx                  # NEW: thin layout (passes through)
    page.tsx                    # was app/page.tsx — My Tasks board
    team/page.tsx               # was app/team/page.tsx
  (sidebar)/                    # sidebar surfaces
    layout.tsx                  # NEW: AppShell + Sidebar chrome
    dashboard/page.tsx          # NEW
    profile/page.tsx            # NEW
    admin/
      ops/page.tsx              # moved from app/admin/ops/
      settings/page.tsx         # moved from app/admin/settings/
  cards/[id]/page.tsx           # unchanged — no sidebar
  setup/...                     # unchanged — own layout
  sign-in/...                   # unchanged — own layout
  api/                          # unchanged
```

URLs stay identical (`/dashboard`, `/admin/ops`, etc.) — route groups
are invisible to users.

### ERD (new tables)

```mermaid
erDiagram
    users ||--o| user_prefs : has
    users ||--o| user_notifications_seen : has

    users {
        text id PK
        text email
        text name
        text role
    }

    user_prefs {
        text user_id PK_FK
        text agent_overrides_json "JSON map agentId → {model?, costWarnUsd?, costKillUsd?}"
        text notifications_json "JSON {onComplete:bool, onFailure:bool, onAwaitingInput:bool}"
        integer updated_at
    }

    user_notifications_seen {
        text user_id PK_FK
        integer last_seen_audit_id "highest audit_log.id the user has seen"
        integer updated_at
    }
```

Both tables are 1:1 with users, lazily populated on first save.

### Data model — `server/db/schema.ts`

```ts
export const userPrefs = sqliteTable("user_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  agentOverridesJson: text("agent_overrides_json").notNull().default("{}"),
  notificationsJson: text("notifications_json").notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const userNotificationsSeen = sqliteTable("user_notifications_seen", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastSeenAuditId: integer("last_seen_audit_id").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
```

### Sidebar anatomy

```
┌──────────────┐
│ ▎LawStack    │ <- Brandmark, links to /
│  /aiops      │
├──────────────┤
│ ◎ Dashboard  │
│ ▣ Board      │ <- collapsible sub-group
│    My Tasks  │ <- active when pathname === "/"
│    Team      │ <- active when pathname === "/team"
│ @ Profile    │
├──────────────┤  ← separator "ADMIN" (hidden if !admin)
│ ⚙ Settings   │
│ ◉ Ops        │
├──────────────┤
│ 🔔 Alerts (3) │ <- NotificationsButton, badge=unread
└──────────────┘
Footer:
  ◐ Theme toggle       ← existing ThemeToggle
  @lawrenze            ← avatar + name
  Sign out             ← auth.js signOut action
```

### Dashboard tile queries

Each tile is a server component reading DB directly. Scoping:

| Viewer | Scope |
|---|---|
| `role === "admin"` | All tasks, all users |
| `role === "member"` | `WHERE tasks.owner_id = :viewerId` |
| `role === "viewer"` (future) | Read-only, everyone's data |

```ts
// components/dashboard/OpsHealthTile.tsx (pseudo)
//   COUNT runs WHERE status IN ('running', 'awaiting_input')
//   COUNT runs WHERE heartbeat < now - 90s AND status = 'running'  (stuck)
//   COUNT audit_log WHERE action LIKE 'run.fail%' AND created_at > now-24h
//
// components/dashboard/CostMeterTile.tsx (pseudo)
//   SUM runs.cost_usd WHERE created_at > today
//   SUM runs.cost_usd WHERE created_at > week
//   SELECT agent_id, SUM(cost_usd) GROUP BY agent_id  (top 3)
//
// components/dashboard/ThroughputTile.tsx (pseudo)
//   audit_log events matching 'lane.enter.<laneId>' grouped by day, last 7 days
//   SVG sparkline per lane (8 sparklines vertically stacked)
//
// components/dashboard/ActivityFeedTile.tsx (pseudo)
//   audit_log LIMIT 20 ORDER BY id DESC JOIN users
```

Each tile is wrapped in its own `try/catch` so one failing query
doesn't blow up the page. Polling reuses the existing
`app/admin/ops/AutoRefresh.tsx` pattern at 15s.

### Notifications tray

Unread count query:

```sql
SELECT COUNT(*) FROM audit_log
 WHERE id > (SELECT last_seen_audit_id FROM user_notifications_seen WHERE user_id = :viewer)
   AND action IN ('run.completed', 'run.failed', 'run.awaiting_input', 'chat.posted')
   AND (   task_id IN (SELECT id FROM tasks WHERE owner_id = :viewer)
        OR actor_user_id != :viewer AND task_id IN (
             SELECT task_id FROM messages WHERE actor_user_id = :viewer
           )
       );
```

Polling: client-side `useEffect` every 30s calls `GET
/api/notifications/unread-count` (returns `{count: number}`).

Panel open → full list via `GET /api/notifications` (returns last 50
matching events joined with tasks + users).

Mark all read: `POST /api/notifications/mark-read` → UPSERT
`user_notifications_seen.last_seen_audit_id = MAX(audit_log.id)`.

### Personal agent defaults — how they apply

Per brainstorm resolved question: **applied at run start**, not task
creation. Current flow in `server/agents/registry.ts:getAgent(id)`:

```ts
// current (instance-wide overrides only)
function getAgent(id) {
  const base = AGENTS[id];
  const overrides = JSON.parse(getConfig("AGENT_OVERRIDES"))[id] ?? {};
  return { ...base, ...overrides };
}

// new (user-scoped on top of instance-wide)
function getAgent(id, opts?: { userId?: string }) {
  const base = AGENTS[id];
  const instanceOverrides = JSON.parse(getConfig("AGENT_OVERRIDES"))[id] ?? {};
  const userOverrides = opts?.userId
    ? JSON.parse(readUserPrefs(opts.userId).agentOverridesJson)[id] ?? {}
    : {};
  return { ...base, ...instanceOverrides, ...userOverrides };
}
```

Every run-start call site already knows `actorUserId` (it's the one
kicking off the run), so the hook-up is mechanical.

### Implementation Phases

#### Phase 1: Layout infrastructure (2 days)

Scaffolds the route-group split without moving any page yet — ship
as a no-op PR so the reshuffle can land in one commit.

- [ ] `app/(board)/layout.tsx` — pass-through layout (children only). *(Phase 2)*
- [ ] `app/(sidebar)/layout.tsx` — imports `AppShell`, wraps children. *(Phase 2)*
- [x] `components/nav/AppShell.tsx` — server wrapper that owns the
      top-level grid: `<Sidebar />` on desktop, `<MobileDrawer />` on
      mobile, children in the content column.
- [x] `components/nav/Sidebar.tsx` — server component that renders
      the role-aware menu; defers active-state to its client child.
- [x] `components/nav/SidebarItem.tsx` — `<Link>` with active-state
      highlight (matches pathname, client).
- [x] `components/nav/SidebarFooter.tsx` — theme toggle, user chip,
      sign-out form (server action).
- [x] `components/nav/MobileDrawer.tsx` — off-canvas drawer with
      Esc/backdrop close; opened by burger button from compact top bar.
- [x] `components/nav/SidebarIcons.tsx` — inline SVG icon set.
- [x] Exit gate: build passes; typecheck clean; no visual change to
      current pages (AppShell not wired anywhere yet).

#### Phase 2: Move pages into groups, wire sidebar (1 day)

- [ ] `git mv` pages:
  - `app/page.tsx` → `app/(board)/page.tsx`
  - `app/team/page.tsx` → `app/(board)/team/page.tsx`
  - `app/admin/ops/` → `app/(sidebar)/admin/ops/`
  - `app/admin/settings/` → `app/(sidebar)/admin/settings/`
- [ ] Update any relative imports broken by the move.
- [ ] `app/(sidebar)/layout.tsx` passes session+role to `<Sidebar>`.
- [ ] Board header (`components/board/Board.tsx:86`) gets a new
      "Dashboard →" NavLink for discoverability.
- [ ] Drift banner (`components/admin/SettingsDriftBanner`) continues
      to render where it renders today (top of board pages + admin
      pages). The sidebar layout mounts it above its content area.
- [ ] Exit gate: every current route still works; admins see admin
      entries in the sidebar, members don't; theme toggle survived the
      move.

#### Phase 3: Dashboard (`/dashboard`) (2 days)

- [ ] `app/(sidebar)/dashboard/page.tsx` — server component; reads
      session; renders 2×2 tile grid.
- [ ] `components/dashboard/OpsHealthTile.tsx` — server component.
- [ ] `components/dashboard/CostMeterTile.tsx` — server component;
      `formatUsd()` helper; uses accent-green for well-under-budget.
- [ ] `components/dashboard/ThroughputTile.tsx` — server component;
      inline SVG sparkline per lane (no charting dep).
- [ ] `components/dashboard/ActivityFeedTile.tsx` — server component;
      renders actor avatar + action + time-ago + link to card.
- [ ] `components/dashboard/DashboardAutoRefresh.tsx` — client shim
      of the existing `AutoRefresh` pattern; polls at 15s.
- [ ] Empty states for each tile when the viewer has zero data.
- [ ] Add indexes if missing: `audit_log.created_at`,
      `audit_log.task_id`, `runs.status`, `runs.heartbeat_at`.
      New migration `0003_dashboard_indexes.sql`.
- [ ] Unit tests for viewer-scoped queries
      (`tests/dashboardQueries.test.ts`): admin sees all vs member
      sees only own.
- [ ] Exit gate: `/dashboard` loads in <300ms with ~50 runs seeded
      in a test DB.

#### Phase 4: Profile (`/profile`) (1.5 days)

- [ ] Migration `0004_user_prefs.sql` — `user_prefs` table.
- [ ] `server/lib/userPrefs.ts` — `readUserPrefs(userId)` /
      `writeUserPrefs(userId, patch)`. UPSERT semantics.
- [ ] `app/(sidebar)/profile/page.tsx` — server component; reads
      user row + prefs; renders three sections.
- [ ] `components/profile/IdentitySection.tsx` — client; editable
      display name, read-only email, theme toggle, sign-out.
- [ ] `components/profile/AgentDefaultsSection.tsx` — client; one
      row per agent in `AGENTS`; `model` select + `costWarnUsd` /
      `costKillUsd` numbers; "reset to instance default" chip.
- [ ] `components/profile/NotificationPrefsSection.tsx` — client;
      three checkboxes (onComplete/onFailure/onAwaitingInput).
- [ ] `app/api/profile/save/route.ts` — POST, auth-gated (viewer
      writes only their own row); validates with zod.
- [ ] `server/agents/registry.ts:getAgent` — accept optional
      `{ userId }`, merge `user_prefs.agent_overrides_json` on top
      of instance overrides.
- [ ] Every run-start call site threads `actorUserId` into
      `getAgent()`. Audit all call sites (`grep -rn "getAgent(" server/`).
- [ ] Unit test: user prefs win over instance overrides.
- [ ] Exit gate: change my cost-warn default → next run warns at the
      new threshold without restart.

#### Phase 5: Notifications tray (1.5 days)

- [ ] Migration `0005_user_notifications_seen.sql`.
- [ ] `components/nav/NotificationsButton.tsx` — bell icon + unread
      badge; client; polls `GET /api/notifications/unread-count`
      every 30s.
- [ ] `components/nav/NotificationsPanel.tsx` — client; slide-out
      panel; lists events; "mark all read" button; keyboard-dismiss
      (Esc); click-outside-to-close.
- [ ] `app/api/notifications/unread-count/route.ts` — auth-gated;
      returns `{count}`; viewer-scoped.
- [ ] `app/api/notifications/route.ts` — GET, returns last 50
      matching events.
- [ ] `app/api/notifications/mark-read/route.ts` — POST, upserts
      `last_seen_audit_id = MAX(audit_log.id)`.
- [ ] Unit test: two users, one marks-read, count for the other is
      untouched.
- [ ] Unit test: admin + member scoping — member sees only own.
- [ ] Exit gate: badge drops to 0 within 1s of "mark all read".

#### Phase 6: Mobile responsive (2 days)

- [ ] Tailwind breakpoints used throughout: `md:` (768px),
      `lg:` (1024px).
- [ ] Sidebar hidden below `lg:`; burger icon in compact top bar
      opens `MobileDrawer`.
- [ ] Dashboard tile grid: `grid-cols-1 md:grid-cols-2`.
- [ ] Board (current top-nav unchanged on `md+`); on mobile, keep
      horizontal swimlane scroll + ensure touch momentum works.
- [ ] Wizard steps fit a 375px screen (inputs full-width, buttons
      stack).
- [ ] Profile sections stack vertically on mobile.
- [ ] All interactive targets ≥44px on touch.
- [ ] Manual matrix test: 375 / 768 / 1024 / 1440 widths on every
      route.
- [ ] Exit gate: on a 375px viewport every page is reachable and
      every action is tappable.

#### Phase 7: Polish + docs (1 day)

- [ ] README "Pages" section mentioning Dashboard + Profile.
- [ ] `docs/install-checklist.md` step: "sign in, open /dashboard,
      confirm tiles render".
- [ ] `components/brand/Brandmark.tsx` — a subtle scale so it fits
      the 240px sidebar header cleanly.
- [ ] Keyboard-nav pass: `Tab` through sidebar, space/enter activates,
      Esc closes drawer and notifications panel.
- [ ] a11y landmarks: `<nav aria-label="Primary">`, `<main>`, role=dialog
      on panel.
- [ ] Smoke-install script: add an assertion that `/api/health`
      still responds + `/dashboard` 302s to sign-in for anon.
- [ ] Exit gate: `npm run smoke:install` green; `npm run typecheck`
      clean; 50+ tests still passing.

**Total: ~11 days.** Descopable to ~7 by cutting:

- Throughput chart (hardest tile; ship 3 tiles instead of 4)
- Notifications tray (ship after MVP; bell icon still visible with
  "coming soon" tooltip)
- Mobile phase (desktop-first release; add responsive in v2)

## Alternative Approaches Considered

### Alt 1: Full-width 240px sidebar on every route

Rejected — the 8-lane board would lose too much horizontal room.
Brainstorm previewed this option and explicitly chose hybrid.

### Alt 2: Icon-only rail that expands on hover

Rejected in brainstorm because the fixed 240px sidebar keeps label
legibility, is simpler, and the board surfaces already don't have a
sidebar anyway so the "lose horizontal pixels" concern doesn't apply
on non-board pages.

### Alt 3: Cram Dashboard into the board header

Rejected — the four tiles are 4 distinct concerns. Trying to wedge
them into chrome makes the board worse and the tiles worse.

### Alt 4: Single `user_prefs_json` column on `users` table

Rejected — JSON-blob-on-users works for a week, becomes a change-
management nightmare over six months. Keep user_prefs separate so
migrations that touch prefs don't touch the auth table.

### Alt 5: SSE for notifications

Rejected for MVP. Polling every 30s is cheap and keeps the panel
simple. Revisit if the audit log grows to multiple events/second
per user.

## System-Wide Impact

### Interaction Graph

When a user clicks `◎ Dashboard` in the sidebar:

```
Link /dashboard
  → middleware.ts (Edge): auth check → pass
  → app/(sidebar)/layout.tsx: auth() → session (id, role, name)
  → AppShell receives role → Sidebar highlights Dashboard item
  → app/(sidebar)/dashboard/page.tsx: auth() again
    → Four parallel server components render
    → Each hits DB directly with role-scoped query
    → AutoRefresh client shim mounts → 15s interval → router.refresh()
```

When a user clicks "mark all read":

```
Button onClick
  → fetch POST /api/notifications/mark-read
  → auth() → userId
  → SELECT MAX(id) FROM audit_log → maxId
  → UPSERT user_notifications_seen (userId, maxId)
  → audit({ action: "notifications.mark_read", actorUserId: userId })
  → Response 200
  → Client re-fetches unread-count → 0 → badge hides
```

When a run completes and a member with notifications opens the tray:

```
Run finishes → runs table updated → audit_log INSERT (run.completed)
  → (no push yet; client polls every 30s)
  → Client poll ticks → GET /api/notifications/unread-count
  → Query counts rows since last_seen_audit_id → returns {count: N}
  → Badge updates
```

### Error & Failure Propagation

- **Dashboard tile query failure** → the tile shows a contained
  "couldn't load" message; sibling tiles render fine (each in its
  own try/catch at the render boundary).
- **`user_prefs` row missing** → `readUserPrefs()` returns defaults
  (`{agent_overrides_json: "{}", notifications_json: "{}"}`); next
  write UPSERTs. No exception bubbles.
- **Invalid JSON in `agent_overrides_json`** → safe-parse helper
  returns `{}` and emits a warning to stdout; run uses instance
  defaults.
- **Notifications poll fails** → badge shows last known count;
  silent retry next tick. Never redirect the user because a poll
  hit a 500.
- **Role missing from JWT** → session read returns `role: "member"`
  (default); sidebar hides admin entries; handlers still 403 if
  touched.

### State Lifecycle Risks

- **`user_prefs` upsert race** — two tabs saving simultaneously: last
  write wins. No surprise; prefs aren't version-sensitive. Document
  this if it ever matters, don't optimistic-lock.
- **`last_seen_audit_id` drift** — if a user has two devices, one
  marks-read resets the count for both (by design). Unread = since
  last-seen for the user, not per-device.
- **Migration order** — `0003_dashboard_indexes` must land before
  `/dashboard` queries hit a table with 10k+ rows in a real install.
  Guard with perf test in CI or a migration-runs-first CI gate.
- **Route-group rename** — moving pages between route groups is a
  `git mv` but if anything references the old path via a typed
  import of the page module, it'll break. Audit before merging.

### API Surface Parity

New routes exposed to clients:

| Method | Route | Auth |
|---|---|---|
| GET | `/api/notifications/unread-count` | session required |
| GET | `/api/notifications` | session required |
| POST | `/api/notifications/mark-read` | session required |
| POST | `/api/profile/save` | session required; can only write self |

Every handler enforces `userId === session.user.id` where relevant —
a member cannot POST to `/api/profile/save` on behalf of another user.

### Integration Test Scenarios

1. **Member sees only own runs on dashboard.** Seed 10 runs across
   2 users, sign in as user A, hit `/dashboard`, assert cost meter
   = A's cost only, activity feed only lists A's transitions.
2. **Admin sees everything on dashboard.** Same seed, sign in as
   admin, assert cost meter = total.
3. **Prefs propagate to next run.** Set `ce:work.costWarnUsd=5` in
   profile, start a run, assert the run row records
   `cost_warn_usd=5`.
4. **Mark-all-read is per-user.** Two users with the same unread
   events — A marks read, B's count stays the same.
5. **Route-group move preserved URLs.** E2E: every existing link
   (e.g., from a Slack message pointing at `/admin/ops`) still
   resolves.

## Acceptance Criteria

### Functional Requirements

- [ ] Every non-board route renders the 240px sidebar; board routes
      render the existing top-nav.
- [ ] Sidebar admin section visible only when `role === "admin"`.
- [ ] `/dashboard` exists, renders 4 tiles, refreshes every 15s.
- [ ] `/profile` exists, edits persist, changes take effect on next
      run without restart.
- [ ] Notifications bell shows correct unread count; "mark all read"
      zeros it; count is per-user.
- [ ] Every existing route (/, /team, /cards/:id, /admin/ops,
      /admin/settings, /setup*, /sign-in) still works unchanged
      aside from chrome.
- [ ] On a 375px viewport every page is reachable and tappable.

### Non-Functional Requirements

- [ ] `/dashboard` server render in <300ms with 50 runs seeded.
- [ ] No N+1 queries (activity tile joins users in-query, doesn't
      per-row lookup).
- [ ] Admin-gated API handlers validate session role independently
      of the sidebar (defense in depth).
- [ ] `aria-current="page"` on active sidebar item; `<nav>` landmark
      present; notifications panel is role=dialog with focus trap.
- [ ] No layout shift on cold load (sidebar has a reserved 240px
      grid column even before hydration).

### Quality Gates

- [ ] `npm run typecheck` clean.
- [ ] `npm test` passes (existing 45 + ~6 new tests = ~51).
- [ ] `npm run smoke:install` passes.
- [ ] Manual pass on 375 / 768 / 1440 widths.
- [ ] No console errors/warnings on the four new pages.

## Success Metrics

- **Discoverability.** Operators who previously learned `/admin/ops`
  by URL memorisation can click to it within one screen on first load.
- **Dashboard latency.** Server render ≤300ms p95 with 50 runs;
  ≤800ms p95 with 500 runs (benchmarked via smoke DB seed).
- **Notifications responsiveness.** Badge reflects new events within
  one poll (≤30s). "Mark all read" clears badge in ≤1s round trip.
- **Zero route breakage.** All pre-existing links continue to work
  after route-group rearrange — verified by a one-off grep +
  smoke-test matrix.

## Dependencies & Prerequisites

- `feat/setup-wizard` branch merged (this branch builds on Phase 1
  config substrate for reading AGENT_OVERRIDES).
- Node 20 (unchanged).
- No new runtime dependencies. No charting library — the throughput
  tile uses hand-rolled inline SVG. Keeps bundle flat.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Route-group rename breaks deep-linked URLs | Low | High | URLs are unaffected by route groups; verify via smoke matrix before merging. |
| Dashboard slow on 10k-run install | Medium | Medium | Add indexes in Phase 3 migration; load-test with seeded DB. |
| Sidebar + Board top-nav duplicated nav confuses users | Medium | Low | Add one "Dashboard" link in board header only; don't add the whole sidebar menu there. |
| Mobile drawer conflicts with HeroUI Dialog | Low | Medium | Use a raw `<dialog>` element with small JS shim; avoid HeroUI's modal for the drawer. |
| User prefs write race across tabs | Low | Low | Document last-write-wins; no optimistic locking. |
| `role` drift between session & DB after admin promotion | Medium | Medium | Document: sign out / sign in required after role change (matches current behaviour with Phase 2 auth). |
| Audit-log query for activity tile gets slow | Medium | Medium | `created_at DESC LIMIT 20` with an index on `created_at`; already cheap. |

## Resource Requirements

- **Team:** one engineer full-time.
- **Time:** ~11 days (~2 weeks wall-clock with interruptions).
- **Infra:** none — same SQLite, same Next.js server, same prod host.

## Future Considerations

Out of scope here, earmarked for v2:

- **Command palette (⌘K).** Global fuzzy search over tasks, agents,
  recent runs. High value once the app grows.
- **Real-time push for notifications** via the existing SSE
  infrastructure (currently used for run streaming). 30s poll is
  fine for now.
- **Per-team dashboards** / project-scoped views. Current scope: one
  dashboard, viewer-scoped.
- **Customisable sidebar order or pinning.** Fixed layout for v1.
- **User-row theme persistence** (follows across devices). Device-local
  for v1 per brainstorm decision.
- **Inbox-style archive for notifications.** Current scope: peek-
  and-dismiss tray, not a full inbox surface.
- **Email/Slack notification delivery** based on profile toggles. V1
  persists the flags only; delivery lives in a separate initiative.

## Documentation Plan

- [ ] `README.md` — Pages section: Dashboard, Profile.
- [ ] `docs/install-checklist.md` — post-install step to verify
      dashboard renders.
- [ ] Screenshots: sidebar collapsed/drawer/dashboard (upload to PR
      description).
- [ ] `docs/conventions/` (if it exists) — note the `(board)` vs
      `(sidebar)` route-group pattern so future pages pick the right
      group.

## Sources & References

### Origin

- **Brainstorm:** [docs/brainstorms/2026-04-22-sidebar-and-nav-upgrade-brainstorm.md](../brainstorms/2026-04-22-sidebar-and-nav-upgrade-brainstorm.md). Key decisions carried forward:
  - Hybrid nav (board keeps top-nav, rest gets 240px sidebar)
  - 4 dashboard tiles (ops, cost, throughput, activity)
  - Profile covers identity, agent defaults, notification prefs
  - Notifications as a tray (not a page)
  - Full mobile responsive
  - Agent prefs apply at run start
  - Theme stays device-local
  - Command palette deferred

### Internal references

- Current board chrome: `components/board/Board.tsx:86`
- Admin ops auto-refresh pattern: `app/admin/ops/AutoRefresh.tsx`
- Admin settings structure: `app/admin/settings/page.tsx`
- Audit log wrapper: `server/auth/audit.ts`, table in
  `server/db/schema.ts`
- Config resolver (for AGENT_OVERRIDES): `server/lib/config.ts:getConfig`
- Agent registry (merge target): `server/agents/registry.ts`
- Settings schema (for reuse): `server/lib/settingsSchema.ts`
- Maintenance gate (role-aware rendering pattern):
  `components/admin/MaintenanceGate.tsx`
- Drift banner: `components/admin/SettingsDriftBanner.tsx`
- Theme tokens: `app/globals.css`
- Brandmark: `components/brand/Brandmark.tsx`

### Related work

- Setup wizard plan: [docs/plans/2026-04-22-feat-setup-wizard-plan.md](./2026-04-22-feat-setup-wizard-plan.md)
- HeroUI migration plan: docs/plans/…heroui-migration…
- Original Next.js swimlanes plan:
  [docs/plans/2026-04-20-feat-nextjs-agent-swimlanes-orchestration-plan.md](./2026-04-20-feat-nextjs-agent-swimlanes-orchestration-plan.md)
