CREATE TABLE `workspace_projects` (
	`host_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`ui` text DEFAULT '{}' NOT NULL,
	`last_used_at` text,
	`snapshot` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`host_id`, `project_id`),
	CONSTRAINT "workspace_projects_ui_json" CHECK(json_valid("workspace_projects"."ui")),
	CONSTRAINT "workspace_projects_snapshot_json" CHECK(json_valid("workspace_projects"."snapshot"))
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_projects_status_order` ON `workspace_projects` (`status`,`sort_order`);--> statement-breakpoint
-- Each project's workspace fields move out of the host catalog's `projects`
-- row into this client's workspace, for the local host.
INSERT OR IGNORE INTO `workspace_projects` (`host_id`, `project_id`, `status`, `sort_order`, `ui`, `last_used_at`, `snapshot`, `updated_at`)
SELECT
	'local',
	`id`,
	`status`,
	`sort_order`,
	COALESCE(json_extract(`metadata`, '$.ui'), '{}'),
	json_extract(`metadata`, '$.lastUsedAt'),
	'{}',
	`updated_at`
FROM `projects`;
