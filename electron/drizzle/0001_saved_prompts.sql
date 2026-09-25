-- Saved prompts, replacing the task pipeline that shipped in v0.21.0.
--
-- One migration for every starting point:
--   fresh install  no `tasks` table, no `chats.task_id`
--   v0.21.0        pipeline `tasks` table and `chats.task_id` (dropped, not converted)
--   pre-release    `tasks` holding saved prompts (carried over)

CREATE TABLE IF NOT EXISTS `saved_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_saved_prompts_order` ON `saved_prompts` (`sort_order`);
--> statement-breakpoint
-- Give every starting point a `tasks` table with a `prompt` column, so one
-- copy works for all of them. Pipeline rows have no prompt and are skipped.
CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`prompt` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
-- dream:ensure-column tasks prompt TEXT NULL
INSERT OR IGNORE INTO `saved_prompts` (`id`, `name`, `prompt`, `sort_order`, `created_at`, `updated_at`)
SELECT `id`, `title`, `prompt`, `sort_order`, `created_at`, `updated_at`
FROM `tasks`
WHERE `prompt` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_chats_task`;
--> statement-breakpoint
-- dream:ensure-column chats task_id TEXT NULL
ALTER TABLE `chats` DROP COLUMN `task_id`;
--> statement-breakpoint
DELETE FROM `config` WHERE `key` IN ('taskConfig', 'tasksProjectId', 'tasksChatPanelWidth', 'pipelineConfig', 'pipelineProjectId');
