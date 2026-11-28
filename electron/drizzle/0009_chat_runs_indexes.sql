CREATE INDEX `idx_chat_runs_chat_position` ON `chat_runs` (`chat_id`,"position" desc);--> statement-breakpoint
CREATE INDEX `idx_chat_runs_live` ON `chat_runs` (`status`) WHERE "chat_runs"."status" IN ('running', 'waiting');--> statement-breakpoint
CREATE INDEX `idx_delegated_tasks_parent_run` ON `delegated_tasks` (`parent_run_id`);