import type { ButtonProps, ChipRootProps } from "@heroui/react";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical design tokens for the HeroUI v3 migration.
//
// Every button and status pill in the app looks up its HeroUI props from
// these tables. Four devs running Phase 2 in parallel must NOT re-derive
// `variant="primary"` vs `variant="secondary"` independently.
//
// Adding a new status / intent? Add a row here; the `satisfies Record<...>`
// constraint makes forgetting to map one a compile error at call sites.
//
// Important — HeroUI v3 API notes:
//   * Button has NO `color` prop; severity is encoded in `variant`
//     (primary | secondary | tertiary | danger | danger-soft | ghost | outline).
//     The "primary" variant uses the theme's accent token — set to electric
//     green in globals.css, so all primary-action buttons render green.
//   * Chip uses `color` (accent|danger|default|success|warning) + `variant`
//     (primary|secondary|soft|tertiary). "primary" = strongest emphasis,
//     "tertiary" = weakest.
// ─────────────────────────────────────────────────────────────────────────────

type ButtonVariant = NonNullable<ButtonProps["variant"]>;
type ChipColor = NonNullable<ChipRootProps["color"]>;
type ChipVariant = NonNullable<ChipRootProps["variant"]>;

// ─── Button intents ──────────────────────────────────────────────────────────

export type ButtonIntent =
  | "primary-action"
  | "success-action"
  | "destructive"
  | "retry"
  | "neutral-secondary"
  | "tab-active"
  | "tab-inactive";

/**
 * Intent → Button props. Spread at call site:
 *
 *   <Button {...BUTTON_INTENTS["primary-action"]} onPress={save}>Save</Button>
 *
 * Note: "success-action" and "primary-action" both render as `variant="primary"`
 * in v3 (theme accent = electric green, so "primary" IS the success colour
 * for this app). They exist as distinct intents so future themes can diverge
 * them without touching call sites.
 */
export const BUTTON_INTENTS = {
  "primary-action": { variant: "primary" },
  "success-action": { variant: "primary" },
  "destructive": { variant: "danger" },
  "retry": { variant: "danger-soft" },
  "neutral-secondary": { variant: "secondary" },
  "tab-active": { variant: "primary" },
  "tab-inactive": { variant: "ghost" },
} as const satisfies Record<ButtonIntent, { variant: ButtonVariant }>;

// ─── Run status chips ────────────────────────────────────────────────────────
//
// Merged vocabulary from the four status-pill implementations that existed
// pre-migration: RunSidebar.StatusBadge, Board.CardStatusBadges,
// CardMainTabs stale pill, ApproveButton's inline chips. Delete those
// bespoke renderers as Phase 2 migrates to this table.

export type RunStatusUI =
  | "running"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cost_killed"
  | "interrupted"
  | "stopped";

export const RUN_STATUS_CHIP = {
  running: { color: "success", variant: "primary" },
  awaiting_input: { color: "accent", variant: "soft" },
  paused: { color: "warning", variant: "soft" },
  completed: { color: "default", variant: "soft" },
  failed: { color: "danger", variant: "soft" },
  cost_killed: { color: "danger", variant: "primary" },
  interrupted: { color: "warning", variant: "soft" },
  stopped: { color: "warning", variant: "tertiary" },
} as const satisfies Record<
  RunStatusUI,
  { color: ChipColor; variant: ChipVariant }
>;

// ─── Review verdict chips ────────────────────────────────────────────────────

export type ReviewVerdictUI = "PASS" | "P1" | "P2_BLOCKER" | "pending";

export const VERDICT_CHIP = {
  PASS: { color: "success", variant: "primary" },
  P1: { color: "danger", variant: "primary" },
  P2_BLOCKER: { color: "warning", variant: "primary" },
  pending: { color: "warning", variant: "soft" },
} as const satisfies Record<
  ReviewVerdictUI,
  { color: ChipColor; variant: ChipVariant }
>;

// ─── Lane chips (for Board + task cards) ─────────────────────────────────────

export type LaneUI =
  | "ticket"
  | "branch"
  | "brainstorm"
  | "plan"
  | "review"
  | "pr"
  | "implement"
  | "done";

export const LANE_CHIP = {
  ticket: { color: "default", variant: "tertiary" },
  branch: { color: "default", variant: "tertiary" },
  brainstorm: { color: "accent", variant: "soft" },
  plan: { color: "accent", variant: "soft" },
  review: { color: "warning", variant: "soft" },
  pr: { color: "accent", variant: "primary" },
  implement: { color: "accent", variant: "primary" },
  done: { color: "success", variant: "soft" },
} as const satisfies Record<
  LaneUI,
  { color: ChipColor; variant: ChipVariant }
>;

// ─── Exports used in typed narrowing helpers ─────────────────────────────────

export type { ButtonVariant, ChipColor, ChipVariant };
