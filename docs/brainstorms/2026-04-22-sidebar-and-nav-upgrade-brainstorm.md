---
title: Sidebar + Navigation Upgrade
status: active
date: 2026-04-22
topic: sidebar-and-nav-upgrade
---

# Sidebar + Navigation Upgrade

Evolve the thin top-nav into a proper operator console: collapsible
left sidebar on every surface **except the board**, plus new Dashboard,
Profile, Notifications, and mobile drawer.

## What we're building

### 1. Layout mode switcher (board vs non-board)

- **Board (`/`, `/team`, `/cards/[id]`)** keeps the current top-nav.
  The swimlane layout is horizontally dense (8 lanes) — a 240px
  sidebar costs too much. Unchanged from today.
- **Every other page** gets a 240px fixed left sidebar. No board
  content ever rides alongside it, so there's no width pressure.

### 2. Sidebar structure

```
┌──────────────┐
│ ▎LawStack    │   Brandmark (link to /)
│  /aiops      │
├──────────────┤
│ ◎ Dashboard  │   NEW  — ops tiles, cost, throughput, activity
│ ▣ Board      │   defaults to /  (My Tasks)
│    My Tasks  │
│    Team      │
│ @ Profile    │   NEW  — per-user
├──────────────┤   ADMIN ONLY ↓
│ ⚙ Settings   │   /admin/settings  (already built)
│ ◉ Ops        │   /admin/ops       (already built)
├──────────────┤
│ 🔔 Alerts    │   NEW  — notifications tray (opens panel)
└──────────────┘
footer:
  ◐ theme toggle
  signed in as @lawrenze
  sign out
```

- Brandmark at top links to `/`.
- Admin section is gated on `role === "admin"`; members don't see
  the horizontal divider or the three admin entries.
- Notifications tray is a button, not a route — opens a side panel.

### 3. Dashboard (new page at `/dashboard`)

Four tiles / sections, arranged in a 2×2 grid:

| Tile | Data source | Refresh |
|---|---|---|
| **Ops health** | `runs` rows with `status IN (running, awaiting_input)`, stuck-heartbeat count, error rate last 24h from `audit_log` | 15s poll (same as `/admin/ops`) |
| **Cost meter** | sum(`runs.cost_usd`) for today / this week, top-3 most expensive runs, per-agent breakdown | 15s |
| **Throughput** | Count of `lane_transition` events per lane over last 7 days, sparkline per lane | 60s |
| **Activity feed** | Last 20 `audit_log` rows joined with users, human-readable messages | 15s |

- All four tiles are server components reading DB directly.
- A single `<AutoRefresh>` wrapper (already used by `/admin/ops`)
  drives the poll cadence.
- Non-admin users see the same dashboard scoped to their own runs
  (cost meter = my cost, activity = my state transitions).

### 4. Profile (new page at `/profile`)

User-owned, no admin privileges needed. Three sections:

- **Identity** — display name (editable), email (read-only), theme
  preference (persisted to user row), sign-out button.
- **Personal agent defaults** — per-user overrides of `costWarnUsd`,
  `costKillUsd`, `model` for each registered agent. Written to a new
  `user_agent_prefs` table, merged on top of instance-wide
  `AGENT_OVERRIDES` at run-start time.
- **Notification prefs** — boolean toggles: email on my run complete,
  email on my run failure, email on `awaiting_input`. Persisted to a
  `user_notification_prefs` table or JSON blob on `users.prefs`.

### 5. Notifications tray

A bell icon in the sidebar with an unread-count badge. Clicking
opens a 400px right-side panel listing recent events from the
`audit_log` scoped to the viewer:

- `run.completed` / `run.failed` for tasks I own
- `run.awaiting_input` for tasks I own
- Chat messages posted to my tasks by someone else

Each row: icon + short text + relative timestamp + link to the card.
"Mark all read" button clears the unread badge (new column on a
`user_notifications_seen` table storing max seen `audit_log.id`).

### 6. Mobile support

Full responsive:

- **<1024px (tablet)** — sidebar converts to an off-canvas drawer
  opened by a burger icon in a compact top bar.
- **<768px (phone)** — board swimlanes stack vertically (horizontal
  scroll kept), dashboard tiles collapse to 1-col, card detail pages
  drop the sidebar entirely.
- Every touch target ≥ 44px, all new components keyboard-navigable.

## Why this approach

**Hybrid nav over full-sidebar or top-nav-only.** A board with 8
lanes wants every horizontal pixel. A dashboard / settings / profile
page wants clear navigation. Using each layout where it fits lets us
have both without compromise.

**Dashboard instead of cramming stats into the board header.** Ops
health + cost + throughput + activity is 4 distinct concerns; trying
to surface them in the swimlane chrome makes both surfaces worse.

**Profile separate from Settings.** Settings is instance-wide wiring
(Google OAuth, Jira, base repo) — gated on admin. Profile is
per-account preference — every user has one. Mixing them invites
accidental over-exposure of admin knobs.

**Notifications as a tray, not a page.** An inbox at `/notifications`
implies stewardship (archiving, filing, marking important). What we
actually need is a peek-and-dismiss surface — a tray matches that.

## Key decisions

| Decision | Choice |
|---|---|
| Board layout | Unchanged — no sidebar |
| Non-board layout | 240px fixed sidebar |
| Mobile | Full responsive (drawer + stacked board + collapsed tiles) |
| Dashboard data | All 4 tiles (ops, cost, throughput, activity) |
| Board sidebar entry | Defaults to `/` (My Tasks), has sub-items |
| Profile scope | Theme, display name, sign-out, agent defaults, notification prefs |
| Settings scope | Admin-only; unchanged from today |
| Notifications | Tray (panel), not a page |
| Command palette | **Deferred** — not in MVP |

## Resolved questions

1. **Sidebar collapsibility** → Always 240px, no collapse toggle in MVP.
   Revisit if small-laptop users complain.
2. **Agent-defaults apply when?** → At run start. Editing your prefs
   takes effect on your next run, even on existing tasks.
3. **Theme preference** → Device-local (next-themes + localStorage),
   unchanged. User-row persistence deferred.

## Success criteria

- Opening `/dashboard` on a team with ~50 runs renders all 4 tiles
  in <300ms on the server.
- Sidebar is the single source of navigation truth on non-board
  pages — nothing else in the chrome provides primary navigation.
- Every admin route is gated in the sidebar AND in the page handler
  (defense in depth).
- On a 375px-wide phone, every page is usable: board scrolls,
  dashboard fits, wizard fits, profile fits.
- Notifications badge drops to 0 within 1s of clicking "Mark all
  read".

## Scope boundaries (explicitly out)

- Command palette (⌘K) — punt.
- In-app email/Slack delivery (profile prefs only set flags; delivery
  infra is separate future work).
- Dashboards per-team or per-project — one dashboard, scoped to
  viewer's role.
- Real-time push for notifications (SSE) — poll on open is fine.
- Customisable sidebar order or pinning — fixed layout.

## References

- Existing board chrome: `components/board/Board.tsx:86`
- Existing admin ops auto-refresh: `app/admin/ops/AutoRefresh.tsx`
- Existing settings UI: `app/admin/settings/page.tsx`
- Audit log: `server/auth/audit.ts`, `audit_log` table
- Design tokens: `app/globals.css` (signal-room palette)
- Brandmark: `components/brand/Brandmark.tsx`
