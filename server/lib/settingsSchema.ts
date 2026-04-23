import "server-only";
import type { ConfigKey } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Declarative schema for the setup wizard + /admin/settings UI.
//
// Both surfaces render from this array. Adding a new configurable field:
//   1. Add a zod entry in server/lib/config.ts under configSchema.
//   2. Add a SettingField row in the appropriate section below.
//   3. Done — wizard and /admin/settings pick it up automatically.
// ─────────────────────────────────────────────────────────────────────────────

export type FieldKind =
  | "text"
  | "password"
  | "textarea"
  | "number"
  | "select"
  | "url"
  | "email"
  | "domain-list"
  | "boolean";

/**
 * Test actions trigger a `/api/setup/test/:id` or `/api/admin/settings/test/:id`
 * request. The id is the action's `kind`. Implementation lives in
 * server/lib/settingsTestActions.ts.
 */
export type TestActionId =
  | "jira"
  | "path"
  | "oauth-shape"
  | "cli"
  | "github-api"
  | "github-workflow";

export type SettingField = {
  /** Must match a key in configSchema. */
  key: ConfigKey | `AGENT_OVERRIDES_${string}`;
  label: string;
  description: string;
  kind: FieldKind;
  /** Render •••• last-4 after save; expose a "Rotate" action. */
  mask?: boolean;
  required?: boolean;
  /** For select: the options. */
  options?: Array<{ value: string; label: string }>;
  /** For number: min/max. */
  min?: number;
  max?: number;
  /** Placeholder shown when empty. */
  placeholder?: string;
};

export type SettingSection = {
  id:
    | "auth"
    | "jira"
    | "paths"
    | "agents"
    | "preview"
    | "ci"
    | "advanced";
  title: string;
  description: string;
  wizardOrder: number;
  /** Wizard shows a "Skip this step" action. */
  wizardOptional?: boolean;
  /** Optional test action for the whole section. */
  test?: {
    id: TestActionId;
    label: string;
    /** Field keys whose values feed into the test payload. */
    requires: string[];
  };
  fields: SettingField[];
};

export const SETTINGS: SettingSection[] = [
  {
    id: "auth",
    title: "Authentication",
    description:
      "Google OAuth credentials and the session-signing secret. Required before any user can sign in.",
    wizardOrder: 1,
    fields: [
      {
        key: "AUTH_SECRET",
        label: "Auth secret",
        description:
          "Signs session JWTs. Leave blank and a 32-byte random secret will be generated for you on save.",
        kind: "password",
        mask: true,
        required: false,
      },
      {
        key: "AUTH_GOOGLE_ID",
        label: "Google OAuth client ID",
        description:
          "From Google Cloud Console → APIs & Services → Credentials. Ends in `.apps.googleusercontent.com`.",
        kind: "text",
        required: true,
      },
      {
        key: "AUTH_GOOGLE_SECRET",
        label: "Google OAuth client secret",
        description: "From the same Credentials page. Never commit this.",
        kind: "password",
        mask: true,
        required: true,
      },
      {
        key: "AUTH_URL",
        label: "Base URL",
        description:
          "Public URL where this orchestrator is served. Pre-filled from the URL you're on right now. Edit if you're behind a reverse proxy and this wizard is running on a different origin than users will hit. Trailing slashes get stripped on save.",
        kind: "url",
        placeholder: "https://ai-ops.example.com",
        required: true,
      },
      {
        key: "ALLOWED_EMAIL_DOMAINS",
        label: "Allowed email domains",
        description:
          "Comma-separated list. Only users with email addresses at these domains can sign in.",
        kind: "domain-list",
        placeholder: "example.com,partner.com",
        required: true,
      },
    ],
  },
  {
    id: "jira",
    title: "Jira",
    description:
      "API credentials for creating comments and reading ticket metadata.",
    wizardOrder: 2,
    test: {
      id: "jira",
      label: "Test Jira credentials",
      requires: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    },
    fields: [
      {
        key: "JIRA_BASE_URL",
        label: "Jira base URL",
        description: "e.g. `https://yourco.atlassian.net`",
        kind: "url",
        placeholder: "https://yourco.atlassian.net",
        required: true,
      },
      {
        key: "JIRA_EMAIL",
        label: "Service account email",
        description: "The Atlassian account that owns the API token below.",
        kind: "email",
        required: true,
      },
      {
        key: "JIRA_API_TOKEN",
        label: "Jira API token",
        description:
          "Generate at id.atlassian.com → Security → API tokens. Needs read+comment on your project.",
        kind: "password",
        mask: true,
        required: true,
      },
      {
        key: "JIRA_START_STATUS",
        label: "Status on run start",
        description:
          "Jira workflow status to transition to when the first agent run begins. Leave as default for most setups.",
        kind: "text",
        placeholder: "In Progress",
      },
      {
        key: "JIRA_REVIEW_STATUS",
        label: "Status on implement complete",
        description:
          "Jira status to transition to when ce:work finishes and the server commits + pushes.",
        kind: "text",
        placeholder: "Code Review",
      },
    ],
  },
  {
    id: "paths",
    title: "Paths & base repo",
    description:
      "Where the orchestrator clones target-repo worktrees and where the base repo lives on disk.",
    wizardOrder: 3,
    test: {
      id: "path",
      label: "Test base repo path",
      requires: ["BASE_REPO"],
    },
    fields: [
      {
        key: "BASE_REPO",
        label: "Base repo path",
        description:
          "Absolute path to the target repo on this machine. The orchestrator creates a git worktree per task from this.",
        kind: "text",
        placeholder: "/var/repos/multiportal",
        required: true,
      },
      {
        key: "WORKTREE_ROOT",
        label: "Worktree root",
        description:
          "Directory where per-task worktrees live. Each task gets a UUID subdirectory.",
        kind: "text",
        placeholder: "/var/aiops/worktrees",
      },
    ],
  },
  {
    id: "agents",
    title: "Agents & cost caps",
    description:
      "Per-agent model + cost guardrails. Prompts, turn limits, and permission modes stay in code.",
    wizardOrder: 4,
    wizardOptional: true,
    fields: [
      {
        key: "AGENT_OVERRIDES",
        label: "Agent overrides (JSON)",
        description:
          "Raw JSON mapping agent id → { costWarnUsd?, costKillUsd?, model? }. The /admin/settings UI exposes a nicer per-agent editor; for now this is the escape hatch.",
        kind: "textarea",
        placeholder: '{"ce:work": {"costWarnUsd": 10, "costKillUsd": 30}}',
      },
    ],
  },
  {
    id: "preview",
    title: "Dev preview (optional)",
    description:
      'Wires the "Preview in dev" button on each card. Point at a local dev checkout of the target repo so the orchestrator can swap branches for you.',
    wizardOrder: 5,
    wizardOptional: true,
    fields: [
      {
        key: "PREVIEW_DEV_PATH",
        label: "Dev checkout path",
        description: "Absolute path to your local dev clone of the target repo.",
        kind: "text",
        placeholder: "/var/www/lawrenze.multiportal.io",
      },
      {
        key: "PREVIEW_DEV_URL",
        label: "Dev URL",
        description:
          "URL where that checkout is served (http(s)://). Opened in a new tab by the Preview button.",
        kind: "url",
        placeholder: "http://lawrenze.multiportal.io",
      },
      {
        key: "PREVIEW_DEV_ENABLE_SHELL",
        label: "Enable Dev Shell tab",
        description:
          "Shows a terminal-style tab on each card. Runs arbitrary commands as the node process user — single-operator only.",
        kind: "boolean",
      },
    ],
  },
  {
    id: "ci",
    title: "Target-repo CI workflow",
    description:
      "Copy the claude-code-review.yml workflow into your target repo's .github/workflows/ so PRs get auto-reviewed + Jira transitions post-merge.",
    wizardOrder: 6,
    wizardOptional: true,
    fields: [],
  },
];

/** Flatten all fields across sections — handy for drift detection. */
export function allSettingFields(): SettingField[] {
  return SETTINGS.flatMap((s) => s.fields);
}

/** Required fields (for settings-drift detection). */
export function requiredSettingFields(): SettingField[] {
  return allSettingFields().filter((f) => f.required);
}

/** Look up a section by id. */
export function getSection(id: SettingSection["id"]): SettingSection | undefined {
  return SETTINGS.find((s) => s.id === id);
}
