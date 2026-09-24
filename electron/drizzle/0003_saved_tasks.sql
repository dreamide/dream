-- The task pipeline is retired: a task is now a saved prompt, app-wide.
-- Pipeline tasks and their step settings are dropped rather than converted.
DROP TABLE IF EXISTS `tasks`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_chats_task`;
--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `task_id`;
--> statement-breakpoint
DELETE FROM `config` WHERE `key` IN ('taskConfig', 'tasksProjectId', 'tasksChatPanelWidth', 'pipelineConfig', 'pipelineProjectId');
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_order` ON `tasks` (`sort_order`);
