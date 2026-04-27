CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version` integer PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `config` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `config_value_json` CHECK(json_valid(`value`))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
  `id` text PRIMARY KEY NOT NULL,
  `path` text NOT NULL,
  `normalized_path` text NOT NULL,
  `name` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `projects_metadata_json` CHECK(json_valid(`metadata`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `projects_normalized_path_unique` ON `projects` (`normalized_path`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_projects_status_order` ON `projects` (`status`, `sort_order`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chats` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `title` text NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `deleted_at` text,
  CONSTRAINT `chats_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `chats_metadata_json` CHECK(json_valid(`metadata`))
);
--> statement-breakpoint
-- dream:ensure-column chats deleted_at TEXT NULL
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_chats_project_updated`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chats_project_updated` ON `chats` (`project_id`, `deleted_at`, `updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL,
  `role` text NOT NULL,
  `sort_order` integer NOT NULL,
  `payload` text NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT `chat_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `chat_messages_payload_json` CHECK(json_valid(`payload`)),
  CONSTRAINT `chat_messages_metadata_json` CHECK(json_valid(`metadata`))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_messages_chat_order` ON `chat_messages` (`chat_id`, `sort_order`);
