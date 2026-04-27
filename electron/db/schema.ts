import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
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
