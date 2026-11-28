import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

export const config = sqliteTable(
  "config",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [check("config_value_json", sql`json_valid(${table.value})`)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    normalizedPath: text("normalized_path").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("open"),
    sortOrder: integer("sort_order").notNull().default(0),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("projects_metadata_json", sql`json_valid(${table.metadata})`),
    index("idx_projects_status_order").on(table.status, table.sortOrder),
    uniqueIndex("projects_normalized_path_unique").on(table.normalizedPath),
  ],
);

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check("chats_metadata_json", sql`json_valid(${table.metadata})`),
    index("idx_chats_project_updated").on(
      table.projectId,
      table.deletedAt,
      table.updatedAt,
    ),
  ],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    sortOrder: integer("sort_order").notNull(),
    payload: text("payload").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("chat_messages_payload_json", sql`json_valid(${table.payload})`),
    check("chat_messages_metadata_json", sql`json_valid(${table.metadata})`),
    index("idx_chat_messages_chat_order").on(table.chatId, table.sortOrder),
  ],
);

/**
 * Saved prompts the user runs in a project's chat whenever needed.
 * App-wide, so every project sees the same list.
 */
export const savedPrompts = sqliteTable(
  "saved_prompts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_saved_prompts_order").on(table.sortOrder)],
);

/**
 * One client's workspace entry for a project on some host: whether it is
 * open (and where in the tab strip), its per-project UI, and when it was last
 * used. The project itself belongs to that host's catalog (`projects` on the
 * host); `snapshot` caches its catalog fields so the project can be shown
 * while the host is unreachable.
 */
export const workspaceProjects = sqliteTable(
  "workspace_projects",
  {
    hostId: text("host_id").notNull(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull().default("open"),
    sortOrder: integer("sort_order").notNull().default(0),
    ui: text("ui").notNull().default("{}"),
    lastUsedAt: text("last_used_at"),
    snapshot: text("snapshot").notNull().default("{}"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hostId, table.projectId] }),
    check("workspace_projects_ui_json", sql`json_valid(${table.ui})`),
    check(
      "workspace_projects_snapshot_json",
      sql`json_valid(${table.snapshot})`,
    ),
    index("idx_workspace_projects_status_order").on(
      table.status,
      table.sortOrder,
    ),
  ],
);

/**
 * The prose of each transcript message (its text parts, joined by U+001F),
 * which transcript search reads instead of whole payloads. Derived: the
 * save path writes it beside each message (saveChatMessages), and a trigger
 * (migration 0003) removes it with its message. A message without text
 * parts has no row.
 */
export const chatMessageText = sqliteTable("chat_message_text", {
  messageRow: text("message_row").primaryKey(),
  messageId: text("message_id"),
  text: text("text").notNull(),
});

export const chatQueues = sqliteTable("chat_queues", {
  chatId: text("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  paused: integer("paused").notNull().default(0),
});

export const providerSessions = sqliteTable(
  "provider_sessions",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.provider] }),
    check("provider_sessions_payload_json", sql`json_valid(${table.payload})`),
  ],
);

export const delegatedTasks = sqliteTable(
  "delegated_tasks",
  {
    id: text("id").primaryKey(),
    parentChatId: text("parent_chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    parentRunId: text("parent_run_id")
      .notNull()
      .references(() => chatRuns.id, { onDelete: "cascade" }),
    childChatId: text("child_chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("idx_delegated_tasks_parent").on(table.parentChatId),
    index("idx_delegated_tasks_parent_run").on(table.parentRunId),
    index("idx_delegated_tasks_child").on(table.childChatId),
  ],
);

export const chatRuns = sqliteTable(
  "chat_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    status: text("status").notNull(),
    request: text("request").notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_chat_runs_queue").on(table.chatId, table.status, table.position),
    index("idx_chat_runs_chat_position").on(table.chatId, desc(table.position)),
    index("idx_chat_runs_live")
      .on(table.status)
      .where(sql`${table.status} IN ('running', 'waiting')`),
    check("chat_runs_request_json", sql`json_valid(${table.request})`),
  ],
);

// A paired device's session on this host (electron/host/auth/). Only a
// verifier of its secret is stored; the bearer secret never is.
export const deviceSessions = sqliteTable(
  "device_sessions",
  {
    id: text("id").primaryKey(),
    deviceName: text("device_name").notNull(),
    clientKind: text("client_kind").notNull(),
    scopes: text("scopes").notNull(),
    verifier: text("verifier").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("device_sessions_scopes_json", sql`json_valid(${table.scopes})`),
  ],
);
