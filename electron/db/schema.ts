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

// ---------------------------------------------------------------------------
// Agent graphs
//
// Graph = desired process (persistent). Run = one attempt to execute that
// process. Node execution = one agent invocation. Loops never mutate the
// graph; they create another execution of an existing node.
// ---------------------------------------------------------------------------

export const agentGraphs = sqliteTable(
  "agent_graphs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    entryNodeId: text("entry_node_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_agent_graphs_project_updated").on(
      table.projectId,
      table.updatedAt,
    ),
  ],
);

export const agentGraphNodes = sqliteTable(
  "agent_graph_nodes",
  {
    id: text("id").primaryKey(),
    graphId: text("graph_id")
      .notNull()
      .references(() => agentGraphs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull().default("agent"),
    /** JSON: { provider, model, modelSpeed, reasoningEffort, agentMode } */
    agent: text("agent").notNull().default("{}"),
    instructions: text("instructions").notNull().default(""),
    maxIterations: integer("max_iterations").notNull().default(5),
    positionX: integer("position_x").notNull().default(0),
    positionY: integer("position_y").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    check("agent_graph_nodes_agent_json", sql`json_valid(${table.agent})`),
    index("idx_agent_graph_nodes_graph").on(table.graphId, table.sortOrder),
  ],
);

export const agentGraphEdges = sqliteTable(
  "agent_graph_edges",
  {
    id: text("id").primaryKey(),
    graphId: text("graph_id")
      .notNull()
      .references(() => agentGraphs.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => agentGraphNodes.id, { onDelete: "cascade" }),
    targetNodeId: text("target_node_id")
      .notNull()
      .references(() => agentGraphNodes.id, { onDelete: "cascade" }),
    /** JSON: { field, operator, value } or null for the fallback edge. */
    condition: text("condition"),
    priority: integer("priority").notNull().default(0),
  },
  (table) => [
    check(
      "agent_graph_edges_condition_json",
      sql`${table.condition} IS NULL OR json_valid(${table.condition})`,
    ),
    index("idx_agent_graph_edges_graph").on(table.graphId),
    index("idx_agent_graph_edges_source").on(
      table.sourceNodeId,
      table.priority,
    ),
  ],
);

export const agentGraphRuns = sqliteTable(
  "agent_graph_runs",
  {
    id: text("id").primaryKey(),
    graphId: text("graph_id")
      .notNull()
      .references(() => agentGraphs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    currentNodeId: text("current_node_id"),
    /** JSON: shared workflow state accumulated across node executions. */
    state: text("state").notNull().default("{}"),
    /** JSON: { entryNodeId, nodes, edges } captured when the run started. */
    graphSnapshot: text("graph_snapshot").notNull().default("{}"),
    maxExecutions: integer("max_executions").notNull().default(50),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    check("agent_graph_runs_state_json", sql`json_valid(${table.state})`),
    check(
      "agent_graph_runs_snapshot_json",
      sql`json_valid(${table.graphSnapshot})`,
    ),
    index("idx_agent_graph_runs_graph_created").on(
      table.graphId,
      table.createdAt,
    ),
    index("idx_agent_graph_runs_project_status").on(
      table.projectId,
      table.status,
    ),
  ],
);

export const agentGraphNodeExecutions = sqliteTable(
  "agent_graph_node_executions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentGraphRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    /** 1-based count of executions of this node within the run. */
    iteration: integer("iteration").notNull(),
    /** 1-based position of this execution within the whole run. */
    sequence: integer("sequence").notNull(),
    status: text("status").notNull().default("pending"),
    /** JSON: { prompt, stateSnapshot } */
    input: text("input").notNull().default("{}"),
    /** Raw agent text output. */
    outputText: text("output_text"),
    /** JSON: NodeResult { summary, data, stateUpdates, artifacts } */
    result: text("result"),
    /** Optional chat id when the execution transcript is stored as a chat. */
    chatId: text("chat_id"),
    error: text("error"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "agent_graph_node_executions_input_json",
      sql`json_valid(${table.input})`,
    ),
    check(
      "agent_graph_node_executions_result_json",
      sql`${table.result} IS NULL OR json_valid(${table.result})`,
    ),
    index("idx_agent_graph_node_executions_run").on(
      table.runId,
      table.sequence,
    ),
    index("idx_agent_graph_node_executions_run_node").on(
      table.runId,
      table.nodeId,
    ),
  ],
);
