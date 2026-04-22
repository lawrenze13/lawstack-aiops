---
title: Refactor — migrate UI to HeroUI v3
type: refactor
status: active
date: 2026-04-22
---

# Refactor — migrate UI to HeroUI v3

## Enhancement summary (2026-04-22)

This plan went through `/ce:deepen-plan` with 10 parallel agents
(framework-docs, best-practices, architecture, simplicity, pattern, performance,
races, typescript, security, frontend-design). Several findings were
plan-level corrections, not additions. **Major changes from the v1 draft:**

1. **Target HeroUI v3, not v2.** v3 (stable in 2026) ships **without** framer-motion,
   **without** `HeroUIProvider`, **without** a `heroui()` tailwind plugin. The v1
   plan's entire "bridge layer" in `tailwind.config.ts` is obsolete. Install
   surface is just `@heroui/react` + `@heroui/styles` + `next-themes`.
2. **HeroUI Tabs keep-mounted is confirmed impossible** (HeroUI issue #1562 still
   open). The v1 plan's "verify and use Tabs" path is removed. Primary path is
   "keep the hand-rolled tab strip, restyle triggers with `<Button variant='light'>`".
3. **dnd-kit + HeroUI `<Card>` is rejected as the draggable root.** Framer-motion
   internal wrappers on Card clash with dnd-kit's pointer sensor + our
   click-vs-drag threshold. Keep raw `<div ref={setNodeRef}>` with HeroUI token
   classes copied onto it.
4. **Canonical tables added** (intent→Button, status→Chip, shared action-error
   slot) so four developers running Phase 2 in parallel don't re-derive the same
   `color="success" variant="flat"` question six times.
5. **"Signal room" aesthetic direction** replaces the default HeroUI palette
   — JetBrains Mono + IBM Plex Sans, electric green accent, 11/12/13/15 scale,
   reject HeroUI's `primary` blue.
6. **Three factual errors corrected** (`ArchiveButton` has no text input;
   `ReviewVerdictBadge` pending is composite; dnd-kit returns `setNodeRef` not
   `ref`).
7. **Realistic bundle budget is 60–90 KB gz** (v3 without framer-motion), not the
   v1 plan's 150 KB. Non-functional target raised to ≤ 120 KB with a Phase 1
   baseline measurement.

### Key improvements folded in

- Provider order — `<ThemeProvider>` wraps everything (no `HeroUIProvider` in v3).
- Subpath imports (`@heroui/react/button`) mandated from day 1, not polish-phase.
- Each phase has a concrete grep-based exit gate.
- Modal close + `router.refresh` race mitigated via
  `onAnimationComplete` callback, not a timer race.
- `<ThemeScript>` inlined in `<head>` before first paint (avoids FOWT strobe).
- `AbortController` pattern for every client-side fetch in migrated components.
- Agent-native architecture: status→chip + intent→button mappings declared in
  typed `const` records with `satisfies`.

## Overview

Replace the raw-Tailwind component layer with **HeroUI v3** across the
orchestrator UI. Goals:

- Consistent, polished primitives (Button, Input, Select, Chip, Modal, Popover)
  without hand-authored styling for each component.
- Accessibility baseline for free — HeroUI v3 is built on React Aria Components
  (keyboard nav, focus traps, ARIA labels, screen-reader announcements).
- Prime the upcoming **setup wizard** (see brainstorm at
  `docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md`) so its multi-step
  form uses professional form primitives from day 1 rather than a third styling
  pass.
- Establish a distinctive **"signal room"** aesthetic (Bloomberg terminal × Linear)
  — the generic HeroUI default would make this tool feel like every other SaaS
  dashboard.

Scope: ~20 component files in `components/card-detail/`, 2 in `components/board/`,
1 in `components/toast/`, plus 5 page files. No backend changes. No schema
changes. Existing 28 vitest tests are server-side and unaffected.

## Problem statement

The orchestrator UI today is entirely hand-styled Tailwind utility classes
layered on a small set of oklch-based CSS custom properties in
`app/globals.css`. This was the right call for the MVP but has hit its ceiling:

1. **Inconsistency.** Four separate status vocabularies
   (`RunSidebar.StatusBadge`, `Board.CardStatusBadges`,
   `ReviewVerdictBadge`, `CardMainTabs` stale pill) each with their own
   green/red/amber rules. Six primary-action buttons each with a different
   intent→color binding (indigo/green/amber/red). `ApproveImplementationButton`
   and `AmendPlanButton` disagree on what "indigo" semantically means.
2. **No a11y baseline.** Raw `<button>` / `<div role="button">` with ad-hoc ARIA.
   Modals don't trap focus. Dropdowns aren't keyboard-navigable.
3. **Forms are primitive.** Every textarea is hand-wired with `disabled` +
   `placeholder`. The coming setup wizard (with per-step live validation, error
   messages, helper text, async Test buttons) would be a mountain of custom work
   without a form library.
4. **Dark mode is half-done.** `globals.css` has a `@media (prefers-color-scheme:
   dark)` block; some components use `dark:` classes; some don't. HeroUI v3's
   `next-themes`-integrated token system unifies this.

## Proposed solution

**Incremental, one category at a time, on HeroUI v3.** Install the library, add
the `ThemeProvider`, update `globals.css` with two new `@import`s, then migrate
components in this fixed order: primitives → composites → polish. Establish the
canonical design tokens and component-props tables **before** the primitive
sweep so every button/chip/status migration is a table lookup, not a decision.

**No bridge layer.** HeroUI v3's tokens *are* oklch CSS custom properties. The
v1 plan's `hsl(from var(...) h s l)` conversion in a `tailwind.config.ts` plugin
is neither needed nor supported — v3 is CSS-first.

**Keep the custom tab strip** in `CardMainTabs.tsx`. HeroUI Tabs cannot preserve
inactive panels (issue #1562), and our SSE+ChatBox keep-mounted invariant is
non-negotiable. Only the tab triggers get restyled with HeroUI buttons.

**Keep the custom ToastHost.** Swapping to `@heroui/toast` would churn ~10 call
sites during a visual refactor — two concerns braided together. Restyle the host
with HeroUI tokens; revisit a full swap in a separate post-migration ticket.

**Keep raw `<div>` as the draggable root on Board cards.** HeroUI Card wraps
content in internal motion containers that clash with dnd-kit's pointer sensor
+ our 5px click-vs-drag threshold. Copy HeroUI token classes onto the div
instead of making Card the root.

## Technical approach

### Architecture (HeroUI v3)

Per framework-docs research, the v3 install is:

```bash
npm install @heroui/react @heroui/styles next-themes
# Pin exact versions; run `npm audit --production` after install.
```

Two new lines in `app/globals.css`:

```css
@import "tailwindcss";
@import "@heroui/styles";   /* HeroUI's CSS-first token layer */
@plugin "@tailwindcss/typography";
/* Existing @theme { --color-* } block stays. HeroUI v3 reads these
   tokens directly — no hsl() bridge or tailwind.config.ts plugin needed. */
```

Delete `app/globals.css`'s `@media (prefers-color-scheme: dark)` block and
switch to `html.dark` as the dark-mode gate. `next-themes` flips the class
client-side.

**Provider wrapper in `app/layout.tsx`:**

```tsx
<html lang="en" suppressHydrationWarning>
  <head>
    {/* Blocking inline script that sets html.dark BEFORE first paint.
        Without this users see a light→dark strobe on cold load. */}
    <ThemeScript />
  </head>
  <body>
    <ThemeProvider attribute="class" defaultTheme="system">
      <AuthProviderClient>
        <ToastHost>{children}</ToastHost>
      </AuthProviderClient>
    </ThemeProvider>
  </body>
</html>
```

No `HeroUIProvider` — removed in v3. React Aria Components inside HeroUI
manage their own context.

### Design system — "signal room"

HeroUI defaults produce a generic SaaS-dashboard look. These overrides keep the
terminal-operator feel:

**Fonts** (self-hosted via `next/font`):
- **Body: JetBrains Mono** — ~60% of visible text in `RunLog.tsx` /
  `RunSidebar.tsx` is already `font-mono`. Make mono the house voice.
- **Display: IBM Plex Sans** — headers, button labels, modal titles.
- **Never Inter.** That's the AI-tool default tell.

**Type scale:** `11 / 12 / 13 / 15 px` — tighter than HeroUI's `12/14/16/18`
default. Matches existing `text-[10px]` / `text-[11px]` rhythm. Body line-height
`1.35`, not HeroUI's `1.5` — cost badges and event rows need to sit tight.

**Colours** — override via HeroUI's theme token layer:
- Keep oklch greys (1.0 → 0.145) as the neutral scale.
- **Single saturated accent: `oklch(0.82 0.18 145)` (electric green).** Maps to
  HeroUI's `primary`. Reject the default `#006FEE` blue.
- Banish the rainbow: `RunLog`'s `toolColor()` currently uses 6 families
  (blue/orange/purple/indigo/cyan/emerald). Collapse to 2 families
  (read / write) distinguished by weight (border vs fill), not hue.
- Status semantics (non-negotiable): green=running, red=failed, amber=waiting,
  blue=info. Use `Chip variant="flat"`, never `solid`.

**Radii:** `6 / 4 / 8` px (Button / Chip / Card). HeroUI's `rounded-medium: 8px`
default is too soft for this product.

**Density:** global `defaultProps: { Button: { size: 'sm' }, Input: { size: 'sm' },
Chip: { size: 'sm' } }`. Override Chip padding to `px-1.5 py-0.5` to match the
existing 9–10px badges.

### Canonical tables (declared ONCE, referenced by every component)

Add `components/ui/tokens.ts`:

```ts
import type { ButtonProps, ChipProps } from "@heroui/react";

type ButtonColor   = NonNullable<ButtonProps["color"]>;
type ButtonVariant = NonNullable<ButtonProps["variant"]>;
type ChipColor     = NonNullable<ChipProps["color"]>;
type ChipVariant   = NonNullable<ChipProps["variant"]>;

/** Intent → Button props. Use via `const p = BUTTON_INTENTS[intent]`. */
export const BUTTON_INTENTS = {
  "primary-action":     { color: "primary", variant: "solid" },
  "success-action":     { color: "success", variant: "solid" },
  "destructive":        { color: "danger",  variant: "solid" },
  "retry":              { color: "warning", variant: "flat"  },
  "neutral-secondary":  { color: "default", variant: "bordered" },
  "tab-active":         { color: "default", variant: "solid" },   // inverse
  "tab-inactive":       { color: "default", variant: "light"  },
} as const satisfies Record<string, { color: ButtonColor; variant: ButtonVariant }>;

/** Run status → Chip props. Covers all four current vocabularies merged. */
export type RunStatusUI =
  | "running" | "awaiting_input" | "paused"
  | "completed" | "failed" | "cost_killed" | "interrupted" | "stopped";

export const RUN_STATUS_CHIP = {
  running:        { color: "success", variant: "dot"  },
  awaiting_input: { color: "primary", variant: "flat" },
  paused:         { color: "warning", variant: "flat" },
  completed:      { color: "default", variant: "flat" },
  failed:         { color: "danger",  variant: "flat" },
  cost_killed:    { color: "danger",  variant: "flat" },
  interrupted:    { color: "warning", variant: "flat" },
  stopped:        { color: "warning", variant: "flat" },
} as const satisfies Record<RunStatusUI, { color: ChipColor; variant: ChipVariant }>;

/** Review verdict → Chip props. */
export const VERDICT_CHIP = {
  PASS:        { color: "success", variant: "solid" },
  P1:          { color: "danger",  variant: "solid" },
  P2_BLOCKER: { color: "warning", variant: "solid" },
  pending:     { color: "warning", variant: "flat"  },
} as const;
```

Delete the bespoke `StatusBadge` component. Every status pill imports from
this module.

### Action-error-slot pattern

Six buttons (`ApproveButton`, `ApproveImplementationButton`, `ImplementButton`,
`AmendPlanButton`, `NewRunButton`, `PreviewDevButton`) each have their own inline
`{error ? <span className="text-xs text-red-700">` pattern. Replace with a single
HeroUI `<Tooltip isOpen={!!error} color="danger" content={error}>` wrapping the
button, OR push errors to ToastHost + clear inline text. Pick one at plan-start
and enforce.

### Component mapping (corrected)

| Current | HeroUI v3 replacement | Notes |
|---|---|---|
| `<button className="...">` | `<Button>` via `BUTTON_INTENTS` | Subpath import `from "@heroui/react/button"` |
| `<textarea>`/`<input>` | `<Textarea>`/`<Input>` | Built-in `isInvalid` + `errorMessage` |
| Status badges (4 vocabularies) | `<Chip>` via `RUN_STATUS_CHIP` / `VERDICT_CHIP` | Single lookup table |
| `<details><summary>` blocker drawer | `<Popover>` | `<PopoverTrigger>` + `<PopoverContent>` |
| `NewTaskDialog` custom modal | `<Modal>` | `onAnimationComplete` callback for `router.refresh` |
| `ArchiveButton` inline confirm | `<Popover>` | **Preserve checkbox-confirm gate; no text input exists today** |
| `CardMainTabs` tab strip | **Keep custom** — skin triggers with `<Button variant="light">` | v3 Tabs unmount inactive panels; breaks SSE invariant |
| Board draggable cards | **Keep raw `<div ref={setNodeRef}>`** with HeroUI token classes | Card's motion wrappers clash with dnd-kit pointer sensor |
| `NewRunButton` agent/lane selects | `<Select>` + `<SelectItem>` | Keyboard nav + typeahead |
| Admin ops tables | `<Table>` | Sorts + pagination free |
| `ReviewVerdictBadge` pending | `<Chip>` + `<Button>` composite, as today | Not a single chip swap |
| `ApproveImplementationButton` finalised | Disabled `<Button color="success" isDisabled>` + ✓ icon | Not a `<Chip>` — the semantic is "completed action", not "status label" |
| Toast host | **Keep custom**, restyle with HeroUI tokens | Option B; swap in a follow-up ticket |
| `DevShell` terminal body | **Raw Tailwind**, only chrome uses HeroUI | Terminal aesthetic must not become a Card |
| `RunLog` event rows | **Raw Tailwind**, only badges/cost use HeroUI | High-frequency re-render cost; Card/Chip around 500 rows = jank |
| `ChangesViewer` diff body | **Raw Tailwind**, only file list uses HeroUI | Green/red diff colors stay hand-tuned |

### Critical implementation details per research

**`next.config.ts` additions (Phase 1, not polish phase):**

```ts
const config = {
  experimental: {
    optimizePackageImports: ["@heroui/react"],
  },
  transpilePackages: ["@heroui/react"],
};
```

**Modal close + `router.refresh()` — use `onAnimationComplete`, not a timer:**

```tsx
<Modal isOpen={open} onOpenChange={setOpen}
  onAnimationComplete={(def) => {
    if (def === "exit" && pendingRefresh.current) {
      pendingRefresh.current = false;
      router.refresh();
    }
  }}>
```

Where `pendingRefresh.current = true` is set in the create-task success handler
before `onOpenChange(false)`. Avoids the ghost-portal race
([full analysis in frontend-races review](#risks)).

**`ThemeScript` before first paint (in `<head>` not `<body>`):**

```tsx
<script dangerouslySetInnerHTML={{__html: `
  (function(){try{var t=localStorage.getItem('theme');
  var m=matchMedia('(prefers-color-scheme: dark)').matches;
  if(t==='dark'||(!t&&m))document.documentElement.classList.add('dark')}catch(e){}})();
`}} />
```

`next-themes` v0.3+ emits this automatically via its `<ThemeScript>`
component — verify the installed version does.

**`AbortController` on every client-side fetch** in components that can
unmount-during-fetch (`ChangesViewer`, `ArtifactViewer`, `ChatBox.send`,
`PreviewDevButton.run`, `NewRunButton.submit`, `DevShell.run`,
`ApproveImplementationButton.run`, `ReviewVerdictBadge.check`). Pattern:

```tsx
useEffect(() => {
  const ac = new AbortController();
  fetch(url, { signal: ac.signal }).then(...).catch((e) => {
    if (e.name !== "AbortError") setError(e.message);
  });
  return () => ac.abort();
}, [url]);
```

### Implementation phases (revised)

**Phase 0: Pre-flight (0.5 day)**

- [ ] Capture Playwright screenshot baselines: 5 pages × 2 themes × 3 states
      (empty / loading / populated). Archive under
      `docs/design/heroui-migration-baseline/`.
- [ ] `npm install --save-exact @heroui/react @heroui/styles next-themes`.
      Run `npm audit --production` and archive the lockfile diff in the PR.
- [ ] Add `experimental.optimizePackageImports` + `transpilePackages` to
      `next.config.ts`.
- [ ] Add `components/ui/tokens.ts` with `BUTTON_INTENTS` + `RUN_STATUS_CHIP`
      + `VERDICT_CHIP` (see above).

**Phase 1: Foundation + smoke validation (0.5 day)**

- [ ] Replace `<html lang="en">` with `<html lang="en" suppressHydrationWarning>`.
- [ ] Add `<ThemeScript>` in `<head>` (verify emitted by next-themes, otherwise
      inline it manually).
- [ ] Wrap the app in `<ThemeProvider attribute="class" defaultTheme="system">`
      — OUTSIDE auth, INSIDE `<body>`. ToastHost stays inside ThemeProvider.
- [ ] Add `@import "@heroui/styles"` to `globals.css` below `@import "tailwindcss"`.
- [ ] Delete the `@media (prefers-color-scheme: dark)` block. Convert the dark
      token overrides to `.dark { ... }`.
- [ ] Add JetBrains Mono + IBM Plex Sans via `next/font` in `app/layout.tsx`.
- [ ] Override HeroUI defaults (primary colour, radii, size `sm`) via the v3
      CSS tokens in `globals.css`.
- [ ] **Smoke test A:** drop a single `<Button>` onto `app/admin/ops/page.tsx`,
      verify it renders with the electric-green primary colour.
- [ ] **Smoke test B (critical):** wrap an existing draggable board card in a
      `<div>` styled with HeroUI's Card tokens (no `<Card>` component). Verify
      dnd-kit drag + click-to-navigate still both work. If not, the plan halts
      here.
- [ ] **Smoke test C:** verify `next-themes` is emitting the pre-hydration
      script — throttle network to Slow 3G, hard reload, look for light→dark
      strobe. Must not strobe.
- [ ] **Deliverable exit gate:** `npm run build` clean, 28 vitest tests pass,
      bundle size measured with `@next/bundle-analyzer` — **target ≤ 120 KB gz
      for HeroUI + styles + next-themes**. Actual expected 60–90 KB.

**Phase 2: Primitives sweep (1 day)**

One atomic PR per sub-step, each with visual regression screenshot.

- [ ] **Buttons.** Replace every hand-styled `<button>` in 14 files with
      `<Button {...BUTTON_INTENTS['primary-action']}>`-style call. `DevShell`'s
      quick-action buttons use `tab-inactive` variant.
      **Explicitly excluded:** `CardMainTabs.tsx`'s `TabButton` component
      (separate custom tab strip lives there — Phase 3 handles it).
- [ ] **Inputs + Textareas.** `ChatBox`, `NewRunButton`, `DevShell`,
      `NewTaskDialog`. Wire `isInvalid` + `errorMessage` where validation
      already runs client-side.
- [ ] **Selects.** `NewRunButton`'s agent + lane dropdowns → `<Select>` with
      controlled `selectedKeys` and a single `asTabKey` validator helper
      (avoids `Key` → string union casts at every call site).
- [ ] **Chips — atomic sweep across ALL sites.** Delete `StatusBadge`. Replace
      every status pill in `RunSidebar`, `Board.CardStatusBadges`,
      `ReviewVerdictBadge` pending branch, `CardMainTabs` stale pill,
      `ApproveButton`'s PR-opened/retry chips, `Board` PR badge. All use the
      `RUN_STATUS_CHIP` / `VERDICT_CHIP` lookup. Do this in ONE commit — half
      the UI on old, half on new, looks broken.
- [ ] **Tooltips.** Replace `title="..."` on icon-only and color-only-conveying
      buttons with `<Tooltip content="...">`.
- [ ] **Exit gate:** `grep -rE '<button\s' components/ app/` should return
      zero in files that aren't DevShell/ChangesViewer (intentional exceptions).
      Same for `<input type=`/`<textarea` for inputs sweep.

**Phase 3: Composites (0.5 day)**

- [ ] **NewTaskDialog → `<Modal>`.** Wire `onAnimationComplete` for the
      `router.refresh` handoff (see "Critical implementation details").
      Preserve `AbortController` on the POST.
- [ ] **ArchiveButton confirm → `<Popover>`.** Preserve the "also delete remote
      branch + close PR" checkbox as an explicit gate — do not drop the
      confirm step.
- [ ] **ReviewVerdictBadge blockers → `<Popover>`.** Content goes as children,
      NOT `dangerouslySetInnerHTML` (explicit a security note).
- [ ] **CardMainTabs — RESTYLE ONLY.** Replace the inner `<button>` tab triggers
      with `<Button variant="light">`. KEEP the `display:hidden` mount
      preservation, KEEP the `history.replaceState` URL sync (don't let HeroUI
      Tabs router-push on click). Do NOT use `<Tabs>`.
- [ ] **Exit gate:** `grep -rE '<details>' components/` returns zero.
      CardMainTabs unchanged in terms of mount strategy (verify via existing
      tab-switch SSE preservation smoke test).

**Phase 4: Polish (0.5 day)**

- [ ] **Board header → keep as custom nav**, restyle links with
      `<Button variant="light">`. Skip `<Navbar>` — too consumer-feeling.
- [ ] **Admin ops tables → `<Table>`.** Sort + pagination free.
- [ ] **Theme toggle** in the header — `<Button isIconOnly>` with sun/moon icon,
      wired to `useTheme()`. Gate `useTheme()` behind a `mounted` boolean to
      avoid hydration mismatch.
- [ ] **Collapse `toolColor()` rainbow** to 2 families in `RunLog.tsx`. Read
      tools use border-only chip; write tools use solid chip. Same accent.
- [ ] **Micro-interactions:**
      - 2px left-border accent-green on active `RunSidebar` item.
      - 200ms flash on `CostBadge` when crossing warn→kill threshold.
      - `<Tooltip>` on truncated tool-call summaries.
- [ ] Remove dead CSS in `globals.css`. Run `grep -rE 'var\(--color-' components/`
      — should return zero (all color references now via HeroUI tokens).

### Final exit gates

- [ ] 28 vitest tests pass.
- [ ] Typecheck + lint clean.
- [ ] Bundle size ≤ 120 KB gz delta (measured via `@next/bundle-analyzer`).
- [ ] No hydration mismatch warnings on any page.
- [ ] Playwright diff vs baseline: visual diffs explained (intentional redesign
      items flagged, no accidental regressions).
- [ ] axe-core pass: zero new critical a11y violations.
- [ ] Manual SSE + NEEDS_INPUT + drag-drop + dark-mode-toggle smoke complete.

## Alternative approaches considered

(Preserved from v1, still valid.)

1. **Keep raw Tailwind, extract in-house component lib** — rejected: doesn't
   get a11y for free, still need form primitives for the wizard.
2. **shadcn/ui (Radix + Tailwind)** — rejected: higher friction than npm-install
   HeroUI; per-component manual install + customisation.
3. **Mantine / Chakra / Material UI** — rejected: not Tailwind-native.
4. **Don't migrate, polish what's there** — rejected: still no a11y baseline;
   form primitives remain a big build.

## System-wide impact

### Interaction graph

`app/layout.tsx` changes propagate to every page. `ThemeProvider` class flip →
CSS cascade repaint (no React re-render tree). Theme toggle in header sets
`html.dark` via next-themes. ToastHost stays singleton. Every `toast.push()`
site unchanged (option B).

### Error & failure propagation

- HeroUI components don't throw on invalid props — they fall back to defaults.
  Low-risk.
- `@heroui/react` install failure = build failure; won't reach production.
- Hydration mismatches possible if `useTheme()` drives render output without a
  `mounted` boolean gate. Enforce the pattern.

### State lifecycle risks (from races review)

1. **Zombie EventSource on tab switch.** If any tab migration accidentally
   unmounts `RunLog` or `ChatBox`, the next mount opens a NEW EventSource while
   the server still has the old one buffered. Server-side `needs_input` sent
   during the switch window may land on the OLD ES (now GC'd); user sees
   chat locked with no banner. **Mitigation:** keep `CardMainTabs`'s
   `display:hidden` mount strategy. Do not use HeroUI Tabs.
2. **`AbortController`-less fetches.** `ChangesViewer` and `ArtifactViewer`
   already fetch on mount without abort. Rapid tab-switching stacks fetches;
   latest response may be an older one. **Mitigation:** add `AbortController`
   to all in-component fetches as part of Phase 3 polish.
3. **Modal + `router.refresh` race.** `NewTaskDialog`'s `router.refresh()` can
   beat the Modal's exit animation, orphaning the portal node in
   `document.body`. **Mitigation:** use `onAnimationComplete` callback, not
   `setTimeout(refresh, 250)`.
4. **FOWT strobe.** Without the inlined `<ThemeScript>` before first paint, cold
   loads show a light→dark flash. **Mitigation:** verify `next-themes` emits
   the script; inline manually if not. Test with Slow 3G + hard reload.
5. **`useTheme()` during render.** Any component that reads the theme to
   decide JSX must gate on `const [mounted, setMounted] = useState(false);
   useEffect(() => setMounted(true), [])` or the server/client hydration
   outputs will differ.
6. **HeroUI Card `layoutId` on drag-drop.** Tempting for the drag animation
   flourish, but re-parents the DOM during transitions while dnd-kit still
   holds a ref. On Safari iOS, `setPointerCapture` on a mid-transition node
   throws `InvalidStateError`. **Mitigation:** don't add `layoutId` in this
   refactor; ship as a follow-up polish if wanted.

### API surface parity

- Board page (`app/page.tsx`) and Team Board page (`app/team/page.tsx`) share
  `components/board/Board.tsx` — one migration covers both.
- Header pattern in Board, Admin, Sign-in — single restyle pass covers all.

### Integration test scenarios (smoke, post-migration)

1. **SSE preserved across tab switch** — open a card with a running implement
   run; switch to Changes; switch back to Run log; verify new events still
   stream without reconnect; `needs_input` banner appears if triggered during
   the switch.
2. **Board drag-drop** — drag a task from Plan → Review; verify optimistic
   update + server PATCH fires; card lands in new lane; click-to-navigate still
   works on a dragged-then-released card.
3. **Modal focus trap** — open NewTaskDialog, Tab through fields, verify focus
   stays in modal; Escape closes; create succeeds and refreshes board without
   ghost portal.
4. **Theme toggle** — flip light/dark; verify every page (Board, Card, Admin,
   Sign-in) adapts instantly, no components stuck in wrong mode.
5. **Cold-load theme** — clear localStorage + hard reload (Slow 3G); verify
   no visible strobe between first paint and hydration.
6. **Rapid tab spam** — Board → Card → Board → Card 5× quickly; verify no
   stacked "Slow down" toasts, no duplicate fetches.
7. **Deeplink hydration** — open `/cards/<id>?tab=plan` cold; verify Plan tab
   active on first paint, not a log→plan flash.

## Acceptance criteria

### Functional

- [ ] All existing user flows work: create task → run lane → chat → approve&PR
      → implement → approve-implementation → review-verdict.
- [ ] Board drag-drop works unchanged.
- [ ] SSE + NEEDS_INPUT loop works across tab switches.
- [ ] Dark-mode toggle works site-wide; no FOWT strobe.
- [ ] Deeplinks to artifact tabs hydrate on correct tab.

### Non-functional

- [ ] `npm run build` clean; zero warnings.
- [ ] `npm run typecheck` clean.
- [ ] All 28 vitest tests pass.
- [ ] **Bundle size delta ≤ 120 KB gz** (measured via `@next/bundle-analyzer`).
- [ ] Zero new critical axe-core violations.
- [ ] No hydration-mismatch console warnings on any page.

### Quality gates

- [ ] `components/ui/tokens.ts` exists and is the single source for every
      Button intent, Chip status, Chip verdict.
- [ ] `grep -rE '<button\s[^>]*className="rounded' components/ app/` = empty
      (except DevShell's terminal buttons, which are documented exceptions).
- [ ] `grep -rE 'var\(--color-' components/ app/` post-Phase-4 = empty.
- [ ] `grep -rE 'toast-[a-z]+-\[9px\]' components/` = empty (no legacy
      hand-rolled chip styles left).
- [ ] `StatusBadge` component file deleted.
- [ ] Playwright baseline + post-migration screenshots archived.

## Success metrics

- Zero functional regressions (integration smoke passes).
- Keyboard nav, focus traps, screen-reader labels working on Modal/Popover/Select
  (React Aria wins).
- Consistent visual vocabulary: 1 primary action colour, 1 destructive colour,
  1 neutral secondary variant site-wide.
- Setup wizard (next plan) builds on HeroUI from day 1 — form primitives
  already validated in production.

## Dependencies & prerequisites

- `@heroui/react` v3.x (pin exact version; verify ≥ 3.0.3 at install time)
- `@heroui/styles` v3.x (ships separately; one CSS import)
- `next-themes` ≥ 0.3 (for `<ThemeScript>` emission)
- Tailwind v4 (already present via `@tailwindcss/postcss@^4.0.0`)
- Next.js 15 App Router + React 19 (already present)
- Node 20+ (already required by better-sqlite3)

**Not needed** (removed from v1 plan):
- ❌ `framer-motion` — v3 doesn't use it
- ❌ `HeroUIProvider` — removed in v3
- ❌ `tailwind.config.ts` with `heroui()` plugin — v3 is CSS-first

## Risk analysis & mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| HeroUI Tabs can't keep-mount → SSE breaks | Confirmed | Critical | Do NOT use HeroUI Tabs; keep custom tab strip with restyled triggers |
| dnd-kit + HeroUI Card ref/motion conflict | High | Critical | Keep raw `<div ref={setNodeRef}>`; copy Card tokens via className |
| Bundle bloat | Low (v3) | Medium | v3 removes framer-motion; subpath imports from day 1; measured in Phase 1 exit gate |
| FOWT strobe on cold load | Medium | Medium | Verify `<ThemeScript>` emitted; Slow 3G hard-reload test |
| Modal close + `router.refresh` ghost portal | Medium | Medium | `onAnimationComplete` callback pattern, not timer |
| `useTheme()` hydration mismatch | Low | Low | Gate on `mounted` boolean; grep-audit post-Phase-4 |
| Canonical-table drift (four status vocabs) | Medium | Medium | All migration PRs reference `components/ui/tokens.ts`; atomic chip sweep |
| AbortController missing on fetches in migrated components | Medium | Low | Add to all Phase-3 composites; lint rule follow-up |
| Supply-chain compromise at install time | Low | High | `--save-exact`, `npm audit`, lockfile-diff in PR; subprocess runs with `--bypassPermissions` so install-time RCE is real |
| Future rehype-raw addition → stored XSS | Low | Critical | "Do NOT enable `rehype-raw` without `rehype-sanitize`" note on all markdown components |
| CSP harder to add later (HeroUI inline `<style>`, next-themes bootstrap script) | — | Medium | Document that a future strict CSP requires script+style nonces; not blocking this PR |

## Resource requirements

- **Engineering:** 1 engineer, **~3 days** (Phase 0 + 1 + 2 + 3 + 4) for a
  full migration. Descoping to Phase 0 + 1 + 2 = ~2 days delivers 80% of the
  value (primitives + tokens) and unblocks the wizard.
- **Review:** 1 reviewer; PR must include baseline + post-migration screenshots.
- **Infra:** none.

## Future considerations

- **Setup wizard** (`docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md`)
  builds on this — multi-step `<Tabs>` (real HeroUI Tabs — wizard steps don't
  need keep-mount), form primitives (`<Input isInvalid>`, `<Button>` +
  `<Spinner>` for Test actions).
- **Toast system swap** to `@heroui/toast` — follow-up ticket; migrate all
  call sites in one commit.
- **Drag-drop layoutId animation** — polish; careful of Safari iOS
  `setPointerCapture` conflicts.
- **Strict CSP** — requires script + style nonces; separate initiative.
- **Storybook** — once every component is HeroUI-backed, adding Storybook is
  trivial.

## Documentation plan

- Update `README.md` component list to mention HeroUI v3.
- Add `docs/design/heroui-conventions.md` — exact "signal room" token values,
  `BUTTON_INTENTS` / `RUN_STATUS_CHIP` rationale, do/don't adopt lists.
- `docs/design/heroui-migration-baseline/` — before screenshots.
- `docs/design/heroui-migration-post/` — after screenshots.

## Sources & references

### Internal

- Component inventory: `components/card-detail/*.tsx` (19 files),
  `components/board/*.tsx` (2 files), `components/toast/*.tsx` (1 file)
- Current theme: `app/globals.css:4–30`
- Drag-drop integration: `components/board/Board.tsx:214–268`
- Tab-state-preservation invariant: `components/card-detail/CardMainTabs.tsx:150-190`
- ChatBox local ES: `components/card-detail/ChatBox.tsx:28–47`

### External (from framework-docs research)

- [HeroUI v3 Getting Started](https://heroui.com/docs/react/getting-started)
- [v3.0.0 release notes](https://heroui.com/docs/react/releases/v3-0-0)
- [Full migration guide](https://heroui.com/docs/react/migration/full-migration)
- [Styling & Theming migration](https://heroui.com/docs/react/migration/styling)
- [Composition / render prop](https://heroui.com/docs/handbook/composition)
- [Issue #1562 — destroyInactiveTabPanel](https://github.com/heroui-inc/heroui/issues/1562)
- [Next.js 15 + HeroUI v3 template](https://github.com/heroui-inc/next-app-template)

### External (from best-practices research)

- [HeroUI Incremental Migration guide](https://heroui.com/docs/react/migration/incremental-migration)
- [shadcn/ui Theming](https://ui.shadcn.com/docs/theming) — semantic-pair token model
- [next-themes hydration guidance (shadcn issue #5552)](https://github.com/shadcn-ui/ui/issues/5552)
- [tailwind-merge + HeroUI tv() discussion (#2288)](https://github.com/shadcn-ui/ui/discussions/2288)
- [Playwright Storybook VRT — Markus Oberlehner](https://markus.oberlehner.net/blog/running-visual-regression-tests-with-storybook-and-playwright-for-free)

### Related work

- **Setup wizard brainstorm:**
  `docs/brainstorms/2026-04-22-setup-wizard-brainstorm.md` — downstream work
  that consumes this refactor's output.

### Deepening agents consulted (2026-04-22)

framework-docs-researcher · best-practices-researcher · architecture-strategist ·
code-simplicity-reviewer · pattern-recognition-specialist · performance-oracle ·
julik-frontend-races-reviewer · kieran-typescript-reviewer · security-sentinel ·
frontend-design (skill application).
