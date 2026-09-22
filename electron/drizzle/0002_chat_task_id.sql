-- dream:ensure-column chats task_id TEXT NULL
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chats_task` ON `chats` (`task_id`);
