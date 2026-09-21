CREATE TABLE IF NOT EXISTS `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `step` text DEFAULT 'backlog' NOT NULL,
  `title` text NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `payload` text DEFAULT '{}' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `tasks_payload_json` CHECK(json_valid(`payload`))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_order` ON `tasks` (`sort_order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_project` ON `tasks` (`project_id`);
