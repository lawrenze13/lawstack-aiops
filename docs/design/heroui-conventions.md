# HeroUI v3 conventions — orchestrator UI

Canonical rules for Button / Chip / Input / Modal / Popover usage after the
2026-04-22 migration. Every PR touching UI should conform to these.

## 1. Always import from subpaths

```ts
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import { Input } from "@heroui/react/input";
import { TextArea } from "@heroui/react/textarea";
import { Checkbox } from "@heroui/react/checkbox";
import { Modal, ModalBackdrop, ModalContainer, ModalDialog, ModalHeader,
         ModalHeading, ModalBody } from "@heroui/react/modal";
import { Popover, PopoverTrigger, PopoverContent, PopoverDialog } from "@heroui/react/popover";
```

Never `import { Button } from "@heroui/react"` — breaks tree-shaking.

## 2. Button intents via `BUTTON_INTENTS`

Every button intent is a row in `components/ui/tokens.ts`. Spread at call site:

```tsx
<Button {...BUTTON_INTENTS["primary-action"]} size="sm" onPress={save}>Save</Button>
```

Available intents: `primary-action`, `success-action`, `destructive`, `retry`,
`neutral-secondary`, `tab-active`, `tab-inactive`. Need a new one? Add a row
to `BUTTON_INTENTS` — the `satisfies Record<...>` will surface misspellings
at compile time.

**Important v3 API differences vs v2:**
- No `color` prop on Button — severity encoded in `variant` (`primary`,
  `secondary`, `tertiary`, `danger`, `danger-soft`, `ghost`, `outline`).
- `isDisabled` (not `disabled`).
- `onPress` (React Aria) — `onClick` also works but `onPress` covers
  touch/keyboard/mouse uniformly.
- No polymorphic `as="a"` prop. For link-styled Buttons use a plain
  `<a>` styled like a Button variant (see `NavLink` in `Board.tsx`).
- No `title` prop — use `<Tooltip>` from `@heroui/react/tooltip` for
  icon-only or color-only-conveying buttons.

## 3. Status/verdict Chips via lookup tables

Three canonical tables in `components/ui/tokens.ts`:

- `RUN_STATUS_CHIP[status]` — running / awaiting_input / paused / completed /
  failed / cost_killed / interrupted / stopped
- `VERDICT_CHIP[verdict]` — PASS / P1 / P2_BLOCKER / pending
- `LANE_CHIP[lane]` — ticket / branch / brainstorm / plan / review / pr /
  implement / done

Fall-back pattern for unknown enum values:

```tsx
const props = RUN_STATUS_CHIP[status] ?? RUN_STATUS_CHIP.completed;
<Chip {...props} size="sm">{status}</Chip>
```

v3 Chip API:
- colors: `accent | danger | default | success | warning` (no `primary`,
  `secondary`, `info`)
- variants: `primary | secondary | soft | tertiary` (emphasis strength —
  `primary` = strongest, `tertiary` = weakest)
- no `dot` variant; use `color="success" variant="primary"` for a live pulse
  or add custom dot via `startContent`.

## 4. Modal pattern — controlled + close-before-refresh

```tsx
const [open, setOpen] = useState(false);
<Modal isOpen={open} onOpenChange={setOpen}>
  <ModalBackdrop>
    <ModalContainer size="md" placement="top">
      <ModalDialog>
        <ModalHeader><ModalHeading>Title</ModalHeading></ModalHeader>
        <ModalBody>...</ModalBody>
      </ModalDialog>
    </ModalContainer>
  </ModalBackdrop>
</Modal>
```

When an action both closes the modal AND triggers `router.refresh()`, close
first with a ~230ms settle window before the refresh — avoids the
ghost-portal race where `router.refresh` reparents the subtree mid-animation:

```ts
setOpen(false);
setTimeout(() => onCreated(), 230);
```

(If v3 adds a stable `onAnimationComplete` callback on ModalContainer later,
replace the timer with that.)

## 5. Popover pattern

```tsx
<Popover>
  <PopoverTrigger>
    <button type="button">...</button>  {/* or a Button */}
  </PopoverTrigger>
  <PopoverContent>
    <PopoverDialog className="max-w-md p-3">
      ...
    </PopoverDialog>
  </PopoverContent>
</Popover>
```

Always render user-supplied content (PR comments, Jira descriptions, Claude
output) as text children — never `dangerouslySetInnerHTML`. **Do NOT enable
`rehype-raw`** in any markdown renderer without also enabling
`rehype-sanitize` (security review flagged this for `ArtifactViewer`,
`DescriptionPanel`, `RunLog`, `ReviewVerdictBadge`).

## 6. Theme tokens

`app/globals.css` establishes the "signal room" palette over HeroUI v3's
defaults:

- `--accent: oklch(0.82 0.18 145)` — electric green. This is what HeroUI's
  "primary" variant renders as. Reject the default blue.
- `--radius: 0.375rem` (6px). Smaller than HeroUI's 0.5rem default.
- Fonts: `--font-body` = JetBrains Mono, `--font-display` = IBM Plex Sans,
  loaded via `next/font`. Reject Inter.
- Base font-size 13px, line-height 1.35 ("signal room" tight density).
- Dark mode gated by `html.dark` class (via next-themes `attribute="class"`).

A legacy `--color-*` alias layer maps to HeroUI v3 tokens for components
still using `bg-[color:var(--color-foreground)]`-style arbitrary values.
Future work: migrate each component to HeroUI's own tokens and remove the
alias layer.

## 7. Hydration-safety rules

- Any component that reads `useTheme()` during render MUST gate on a
  `mounted` boolean. SSR can't know theme preference, so server and client
  outputs would diverge without this. See `ThemeToggle.tsx` for the pattern.
- Any component rendering `Date.now()`-derived text MUST gate on `mounted`
  too. See `LiveStatusLine` in `RunLog.tsx`.
- `<html>` gets `suppressHydrationWarning` (only) because next-themes writes
  `html.dark` client-side before React hydrates.

## 8. Intentional exceptions to this convention

These components deliberately do NOT migrate to HeroUI primitives:

- **`DevShell.tsx`** — terminal aesthetic. Quick-action buttons and command
  input stay on raw Tailwind with green-on-black styling.
- **`ChangesViewer.tsx`** file-list row buttons — dense row-click pattern
  doesn't fit HeroUI Button chrome.
- **`RunLog.tsx`** event rows — high-frequency re-render during SSE replay
  (~150ms per event). HeroUI wrappers would add per-event context-read cost.
- **`CardMainTabs.tsx`** — tab strip uses custom `display:hidden` mount
  preservation to keep `RunLog` + `ChatBox` EventSources alive across tab
  switches. HeroUI `<Tabs>` unmounts inactive panels (issue #1562) which
  would break SSE continuity. Only the tab TRIGGER buttons use HeroUI.
- **Board draggable card roots** — raw `<div ref={setNodeRef}>` with HeroUI
  token classes. Wrapping with HeroUI Card's internal motion containers
  clashes with dnd-kit's pointer sensor + our click-vs-drag threshold.

If you touch one of these and think "I should migrate this to HeroUI" —
read the invariant notes in each file first. There's a reason.
