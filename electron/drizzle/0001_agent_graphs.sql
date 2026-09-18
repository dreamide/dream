CREATE TABLE `agent_graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`condition` text,
	`priority` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `agent_graphs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `agent_graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `agent_graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_graph_edges_condition_json" CHECK("agent_graph_edges"."condition" IS NULL OR json_valid("agent_graph_edges"."condition"))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_graph_edges_graph` ON `agent_graph_edges` (`graph_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_graph_edges_source` ON `agent_graph_edges` (`source_node_id`,`priority`);--> statement-breakpoint
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
CREATE TABLE `agent_graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'agent' NOT NULL,
	`agent` text DEFAULT '{}' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`max_iterations` integer DEFAULT 5 NOT NULL,
	`position_x` integer DEFAULT 0 NOT NULL,
	`position_y` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `agent_graphs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_graph_nodes_agent_json" CHECK(json_valid("agent_graph_nodes"."agent"))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_graph_nodes_graph` ON `agent_graph_nodes` (`graph_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `agent_graph_runs` (
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
	FOREIGN KEY (`graph_id`) REFERENCES `agent_graphs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_graph_runs_state_json" CHECK(json_valid("agent_graph_runs"."state")),
	CONSTRAINT "agent_graph_runs_snapshot_json" CHECK(json_valid("agent_graph_runs"."graph_snapshot"))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_graph_runs_graph_created` ON `agent_graph_runs` (`graph_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_graph_runs_project_status` ON `agent_graph_runs` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_graphs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`entry_node_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_graphs_project_updated` ON `agent_graphs` (`project_id`,`updated_at`);