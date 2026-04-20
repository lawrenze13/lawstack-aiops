import { z } from "zod";

// Single source of truth for env vars. Validation runs once at module import
// time. Auth + Jira + GitHub credentials are *optional in the schema* — the
// consuming modules surface clear runtime errors when they're missing. This
// keeps `npm run build` working in CI without needing real secrets.

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_SECRET: z.string().min(32).optional(),
  AUTH_GOOGLE_ID: z.string().min(1).optional(),
  AUTH_GOOGLE_SECRET: z.string().min(1).optional(),
  AUTH_URL: z.string().url().optional(),
  ALLOWED_EMAIL_DOMAIN: z.string().min(1).default("multiportal.io"),
  JIRA_BASE_URL: z.string().url().optional(),
  JIRA_EMAIL: z.string().email().optional(),
  JIRA_API_TOKEN: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).default("./data/app.db"),
  WORKTREE_ROOT: z.string().min(1).default("/var/aiops/worktrees"),
  BASE_REPO: z.string().min(1).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
