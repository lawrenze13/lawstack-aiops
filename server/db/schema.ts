import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Auth.js v5 tables ──────────────────────────────────────────────────────
// Required by @auth/drizzle-adapter. Schema mirrors the official adapter.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique().notNull(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
  // App-level role; not part of the adapter, populated on first sign-in.
  role: text("role", { enum: ["admin", "member", "viewer"] }).notNull().default("member"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const accounts = sqliteTable(
  "accounts",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: uniqueIndex("accounts_provider_pk").on(t.provider, t.providerAccountId),
  }),
);

export const sessions = sqliteTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
});

export const verificationTokens = sqliteTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    pk: uniqueIndex("verification_tokens_pk").on(t.identifier, t.token),
  }),
);

// Belt-and-braces second gate beyond the domain check. Lets admins disable
// access for an off-boarding teammate before their Google Workspace account
// is fully deprovisioned.
export const allowedEmail = sqliteTable("allowed_email", {
  email: text("email").primaryKey(),
  addedBy: text("added_by"),
  addedAt: integer("added_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// ─── Domain tables ──────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    jiraKey: text("jira_key").notNull(),
    title: text("title").notNull(),
    descriptionMd: text("description_md").notNull().default(""),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    currentLane: text("current_lane", {
      enum: [
        "ticket",
        "branch",
        "brainstorm",
        "plan",
        "review",
        "pr",
        "implement",
        "done",
      ],
    })
      .notNull()
      .default("ticket"),
    currentRunId: text("current_run_id"),
    jiraSynced: integer("jira_synced", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // UNIQUE per jira_key while active. Archived tasks free the key for re-use.
    activeJiraKey: uniqueIndex("tasks_active_jira_key_uk")
      .on(t.jiraKey)
      .where(sql`status <> 'archived'`),
    ownerIdx: index("tasks_owner_idx").on(t.ownerId),
    statusIdx: index("tasks_status_idx").on(t.status),
  }),
);

export const agentConfig = sqliteTable("agent_config", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  skillHint: text("skill_hint"),
  model: text("model").notNull(),
  maxTurns: integer("max_turns").notNull().default(30),
  configHash: text("config_hash").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    lane: text("lane", {
      enum: ["brainstorm", "plan", "review", "pr", "implement"],
    }).notNull(),
    agentId: text("agent_id").notNull(),
    agentConfigSnapshotJson: text("agent_config_snapshot_json").notNull(),
    claudeSessionId: text("claude_session_id"),
    status: text("status", {
      enum: [
        "running",
        "completed",
        "failed",
        "stopped",
        "cost_killed",
        "interrupted",
        "awaiting_input",
      ],
    })
      .notNull()
      .default("running"),
    resumedFromRunId: text("resumed_from_run_id"),
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    // Store as integer micros ($1.234567 = 1234567) to avoid float math.
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    numTurns: integer("num_turns").notNull().default(0),
    lastAssistantSeq: integer("last_assistant_seq").notNull().default(0),
    lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    killedReason: text("killed_reason"),
  },
  (t) => ({
    taskLaneIdx: index("runs_task_lane_idx").on(t.taskId, t.lane),
    statusIdx: index("runs_status_idx").on(t.status),
    heartbeatIdx: index("runs_heartbeat_idx").on(t.lastHeartbeatAt),
  }),
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // Monotonic per run; doubles as SSE event id for Last-Event-ID replay.
    seq: integer("seq").notNull(),
    type: text("type", {
      enum: ["system", "assistant", "user", "stream_event", "result", "server"],
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    runSeq: uniqueIndex("messages_run_seq_uk").on(t.runId, t.seq),
  }),
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["brainstorm", "plan", "review", "implementation"],
    }).notNull(),
    filename: text("filename").notNull(),
    markdown: text("markdown").notNull(),
    isApproved: integer("is_approved", { mode: "boolean" }).notNull().default(false),
    isStale: integer("is_stale", { mode: "boolean" }).notNull().default(false),
    supersedesId: text("supersedes_id"),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    approvedBy: text("approved_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    taskKindIdx: index("artifacts_task_kind_idx").on(t.taskId, t.kind),
  }),
);

export const worktrees = sqliteTable("worktrees", {
  path: text("path").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .unique()
    .references(() => tasks.id, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  status: text("status", { enum: ["live", "removed"] }).notNull().default("live"),
});

export const prRecords = sqliteTable("pr_records", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha"),
  prUrl: text("pr_url"),
  jiraCommentId: text("jira_comment_id"),
  state: text("state", {
    enum: [
      "drafting",
      "committed",
      "pushed",
      "pr_opened",
      "jira_notified",
      "failed_at_drafting",
      "failed_at_commit",
      "failed_at_push",
      "failed_at_pr",
      "failed_at_jira",
    ],
  }).notNull(),
  openedAt: integer("opened_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    actorUserId: text("actor_user_id"),
    actorIp: text("actor_ip"),
    action: text("action").notNull(),
    taskId: text("task_id"),
    runId: text("run_id"),
    payloadJson: text("payload_json"),
  },
  (t) => ({
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId),
    actionIdx: index("audit_log_action_idx").on(t.action),
    tsIdx: index("audit_log_ts_idx").on(t.ts),
  }),
);

// ─── Type exports for the app ──────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Worktree = typeof worktrees.$inferSelect;
export type PrRecord = typeof prRecords.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
