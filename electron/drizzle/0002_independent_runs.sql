-- Preserve executions while rebuilding their parent inside the migration transaction.
CREATE TEMP TABLE `__saved_graph_executions` AS SELECT * FROM `agent_graph_node_executions`;--> statement-breakpoint
DROP TABLE `agent_graph_node_executions`;--> statement-breakpoint
CREATE TABLE `__new_agent_graph_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_node_id` text,
	`state` text DEFAULT '{}' NOT NULL,
	`graph_snapshot` text DEFAULT '{}' NOT NULL,
	`max_executions` integer DEFAULT 50 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_graph_runs_state_json" CHECK(json_valid("__new_agent_graph_runs"."state")),
	CONSTRAINT "agent_graph_runs_snapshot_json" CHECK(json_valid("__new_agent_graph_runs"."graph_snapshot"))
);
--> statement-breakpoint
INSERT INTO `__new_agent_graph_runs`("id", "graph_id", "project_id", "status", "current_node_id", "state", "graph_snapshot", "max_executions", "error", "created_at", "started_at", "completed_at") SELECT "id", "graph_id", "project_id", "status", "current_node_id", "state", "graph_snapshot", "max_executions", "error", "created_at", "started_at", "completed_at" FROM `agent_graph_runs`;--> statement-breakpoint
DROP TABLE `agent_graph_runs`;--> statement-breakpoint
ALTER TABLE `__new_agent_graph_runs` RENAME TO `agent_graph_runs`;--> statement-breakpoint
CREATE INDEX `idx_agent_graph_runs_graph_created` ON `agent_graph_runs` (`graph_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_graph_runs_project_status` ON `agent_graph_runs` (`project_id`,`status`);
--> statement-breakpoint
CREATE TABLE `agent_graph_node_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`sequence` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`output_text` text,
	`result` text,
	`chat_id` text,
	`error` text,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_graph_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_graph_node_executions_input_json" CHECK(json_valid("agent_graph_node_executions"."input")),
	CONSTRAINT "agent_graph_node_executions_result_json" CHECK("agent_graph_node_executions"."result" IS NULL OR json_valid("agent_graph_node_executions"."result"))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_graph_node_executions_run` ON `agent_graph_node_executions` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_agent_graph_node_executions_run_node` ON `agent_graph_node_executions` (`run_id`,`node_id`);--> statement-breakpoint

INSERT INTO `agent_graph_node_executions` SELECT * FROM `__saved_graph_executions`;--> statement-breakpoint
DROP TABLE `__saved_graph_executions`;
