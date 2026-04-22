import { z } from "zod";

// Single source of truth for env vars. Validation runs once at module import
// time. Auth + Jira + GitHub credentials are *optional in the schema* — the
// consuming modules surface clear runtime errors when they're missing. This
// keeps `npm run build` working in CI without needing real secrets.

// Treat empty strings as "not set" so a blank `FOO=` line in .env doesn't
// fail validation rules like `.min(32)`.
// `.optional()` must live inside the preprocess so undefined is accepted by
// the inner schema (otherwise z.string().min(32) sees undefined → "Required").
const optionalStr = (inner: z.ZodString) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    inner.optional(),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_SECRET: optionalStr(z.string().min(32)),
  AUTH_GOOGLE_ID: optionalStr(z.string().min(1)),
  AUTH_GOOGLE_SECRET: optionalStr(z.string().min(1)),
  AUTH_URL: optionalStr(z.string().url()),
  // Comma-separated list of allowed email domains (case-insensitive).
  // Example: "multiportal.io,hostednetwork.com.au"
  ALLOWED_EMAIL_DOMAINS: z.string().min(1).default("multiportal.io"),
  // Jira status to transition to when the first agent run starts.
  // Best-effort — silent no-op if the workflow doesn't expose this transition.
  JIRA_START_STATUS: z.string().min(1).default("In Progress"),
  // Jira status to transition to when ce:work implementation finishes
  // cleanly. Best-effort same as JIRA_START_STATUS.
  JIRA_REVIEW_STATUS: z.string().min(1).default("Code Review"),
  JIRA_BASE_URL: optionalStr(z.string().url()),
  JIRA_EMAIL: optionalStr(z.string().email()),
  JIRA_API_TOKEN: optionalStr(z.string().min(1)),
  DATABASE_URL: z.string().min(1).default("./data/app.db"),
  WORKTREE_ROOT: z.string().min(1).default("/var/aiops/worktrees"),
  BASE_REPO: optionalStr(z.string().min(1)),
  // Local dev checkout used by the "Preview in dev" button. When unset,
  // the button is hidden. Path is the filesystem root; URL is how the
  // browser reaches it.
  PREVIEW_DEV_PATH: optionalStr(z.string().min(1)),
  PREVIEW_DEV_URL: optionalStr(z.string().url()),
  // Opt-in shell access from the card's "Dev Shell" tab. OFF by default
  // because it's effectively remote code execution as the node process
  // user — fine for a single-operator dev box, not for shared prod.
  PREVIEW_DEV_ENABLE_SHELL: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

/** Parsed list of allowed email domains, lowercased, trimmed, no empties. */
export const ALLOWED_DOMAINS: readonly string[] = env.ALLOWED_EMAIL_DOMAINS
  .toLowerCase()
  .split(",")
  .map((d) => d.trim())
  .filter((d) => d.length > 0);
