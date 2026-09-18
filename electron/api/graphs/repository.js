import { randomUUID } from "node:crypto";
import { getPersistedStateDatabase } from "../../persisted-state.js";
import { nodeType, normalizeEdges } from "./outcomes.js";

/**
 * SQLite persistence for agent graphs, runs and node executions.
 *
 * Uses the shared state database (WAL) with plain prepared statements, the
 * same style as `persisted-state.js`. Every function is synchronous.
 */

const DEFAULT_MAX_ITERATIONS = 5;
export const DEFAULT_MAX_EXECUTIONS = 50;

const now = () => new Date().toISOString();

const parseJson = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toJson = (value, fallback = "{}") =>
  value === undefined || value === null ? fallback : JSON.stringify(value);

const runInTransaction = (database, callback) => {
  database.exec("BEGIN");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const mapGraph = (row) =>
  row
    ? {
        createdAt: row.created_at,
        description: row.description ?? "",
        entryNodeId: row.entry_node_id ?? null,
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        updatedAt: row.updated_at,
      }
    : null;

const mapNode = (row) => ({
  agent: parseJson(row.agent, {}),
  graphId: row.graph_id,
  id: row.id,
  instructions: row.instructions ?? "",
  maxIterations: row.max_iterations ?? DEFAULT_MAX_ITERATIONS,
  name: row.name,
  outputs: parseJson(row.outputs, []),
  position: { x: row.position_x ?? 0, y: row.position_y ?? 0 },
  sortOrder: row.sort_order ?? 0,
  type: nodeType({ type: row.type }),
});

const mapEdge = (row) => ({
  condition: row.condition === null ? null : parseJson(row.condition, null),
  graphId: row.graph_id,
  id: row.id,
  priority: row.priority ?? 0,
  sourceNodeId: row.source_node_id,
  targetNodeId: row.target_node_id,
});

const mapRun = (row) =>
  row
    ? {
        completedAt: row.completed_at ?? null,
        createdAt: row.created_at,
        currentNodeId: row.current_node_id ?? null,
        error: row.error ?? null,
        graphId: row.graph_id,
        graphSnapshot: parseJson(row.graph_snapshot, {}),
        id: row.id,
        maxExecutions: row.max_executions ?? DEFAULT_MAX_EXECUTIONS,
        projectId: row.project_id,
        startedAt: row.started_at ?? null,
        state: parseJson(row.state, {}),
        status: row.status,
      }
    : null;

const mapExecution = (row) =>
  row
    ? {
        chatId: row.chat_id ?? null,
        completedAt: row.completed_at ?? null,
        error: row.error ?? null,
        id: row.id,
        input: parseJson(row.input, {}),
        iteration: row.iteration,
        nodeId: row.node_id,
        outputText: row.output_text ?? null,
        result: row.result === null ? null : parseJson(row.result, null),
        runId: row.run_id,
        sequence: row.sequence,
        startedAt: row.started_at ?? null,
        status: row.status,
      }
    : null;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const createGraphRepository = ({ databasePath } = {}) => {
  const db = () => getPersistedStateDatabase({ databasePath });

  const getNodesForGraph = (graphId) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_nodes WHERE graph_id = ? ORDER BY sort_order, id",
      )
      .all(graphId)
      .map(mapNode);

  const getEdgesForGraph = (graphId) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_edges WHERE graph_id = ? ORDER BY priority, id",
      )
      .all(graphId)
      .map(mapEdge);

  const getGraph = (graphId) => {
    const graph = mapGraph(
      db().prepare("SELECT * FROM agent_graphs WHERE id = ?").get(graphId),
    );
    if (!graph) {
      return null;
    }
    // `outputs`/`condition` only exist on graphs saved by earlier versions;
    // they are folded into success/failure edges here and never sent on.
    const storedNodes = getNodesForGraph(graphId);
    return {
      ...graph,
      edges: normalizeEdges(storedNodes, getEdgesForGraph(graphId)),
      nodes: storedNodes.map(({ outputs: _outputs, ...node }) => node),
    };
  };

  const listGraphs = (projectId) =>
    db()
      .prepare(
        "SELECT * FROM agent_graphs WHERE project_id = ? ORDER BY updated_at DESC, id",
      )
      .all(projectId)
      .map(mapGraph);

  const createGraph = ({ projectId, name, description = "", id }) => {
    const timestamp = now();
    const graphId = id ?? randomUUID();
    db()
      .prepare(
        `INSERT INTO agent_graphs (id, project_id, name, description, entry_node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(graphId, projectId, name, description, timestamp, timestamp);
    return getGraph(graphId);
  };

  const updateGraph = (graphId, patch) => {
    const current = mapGraph(
      db().prepare("SELECT * FROM agent_graphs WHERE id = ?").get(graphId),
    );
    if (!current) {
      return null;
    }
    db()
      .prepare(
        `UPDATE agent_graphs SET name = ?, description = ?, entry_node_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        patch.entryNodeId === undefined
          ? current.entryNodeId
          : patch.entryNodeId,
        now(),
        graphId,
      );
    return getGraph(graphId);
  };

  const deleteGraph = (graphId) => {
    const result = db()
      .prepare("DELETE FROM agent_graphs WHERE id = ?")
      .run(graphId);
    return Number(result.changes ?? 0) > 0;
  };

  /**
   * Replaces the full node/edge definition of a graph. The editor saves the
   * whole graph at once, which keeps the API surface tiny and avoids partial
   * states. Runs retain their own immutable node/edge snapshot.
   */
  const saveGraphDefinition = (graphId, { entryNodeId, nodes, edges }) =>
    runInTransaction(db(), () => {
      const database = db();
      const existing = mapGraph(
        database
          .prepare("SELECT * FROM agent_graphs WHERE id = ?")
          .get(graphId),
      );
      if (!existing) {
        return null;
      }

      const nodeIds = new Set(nodes.map((node) => node.id));

      // Delete edges first so node deletes never trip FK checks on edges we
      // are about to re-insert anyway.
      database
        .prepare("DELETE FROM agent_graph_edges WHERE graph_id = ?")
        .run(graphId);

      if (nodeIds.size === 0) {
        database
          .prepare("DELETE FROM agent_graph_nodes WHERE graph_id = ?")
          .run(graphId);
      } else {
        database
          .prepare(
            `DELETE FROM agent_graph_nodes WHERE graph_id = ? AND id NOT IN (${[
              ...nodeIds,
            ]
              .map(() => "?")
              .join(", ")})`,
          )
          .run(graphId, ...nodeIds);
      }

      const upsertNode = database.prepare(
        `INSERT INTO agent_graph_nodes
           (id, graph_id, name, type, agent, instructions, max_iterations, position_x, position_y, sort_order, outputs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           agent = excluded.agent,
           instructions = excluded.instructions,
           max_iterations = excluded.max_iterations,
           position_x = excluded.position_x,
           position_y = excluded.position_y,
           sort_order = excluded.sort_order,
           outputs = excluded.outputs`,
      );
      nodes.forEach((node, index) => {
        upsertNode.run(
          node.id,
          graphId,
          node.name,
          nodeType(node),
          toJson(node.agent ?? {}),
          node.instructions ?? "",
          node.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          Math.round(node.position?.x ?? 0),
          Math.round(node.position?.y ?? 0),
          index,
        );
      });

      const insertEdge = database.prepare(
        `INSERT INTO agent_graph_edges
           (id, graph_id, source_node_id, target_node_id, condition, priority)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of edges) {
        insertEdge.run(
          edge.id,
          graphId,
          edge.sourceNodeId,
          edge.targetNodeId,
          toJson({
            field: "status",
            operator: "eq",
            value: edge.outcome === "failure" ? "failure" : "success",
          }),
          0,
        );
      }

      const resolvedEntry =
        entryNodeId && nodeIds.has(entryNodeId)
          ? entryNodeId
          : (nodes[0]?.id ?? null);
      database
        .prepare(
          "UPDATE agent_graphs SET entry_node_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(resolvedEntry, now(), graphId);

      return getGraph(graphId);
    });

  // ── Runs ─────────────────────────────────────────────────────────────

  const getRun = (runId) =>
    mapRun(
      db().prepare("SELECT * FROM agent_graph_runs WHERE id = ?").get(runId),
    );

  const listRuns = (graphId, { limit = 50 } = {}) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_runs WHERE graph_id = ? ORDER BY created_at DESC, id LIMIT ?",
      )
      .all(graphId, limit)
      .map(mapRun);

  const listProjectRuns = (projectId, { limit = 200 } = {}) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_runs WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?",
      )
      .all(projectId, limit)
      .map(mapRun);

  const listRunsByStatus = (status) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_runs WHERE status = ? ORDER BY created_at",
      )
      .all(status)
      .map(mapRun);

  const getActiveRunForProject = (projectId) =>
    mapRun(
      db()
        .prepare(
          "SELECT * FROM agent_graph_runs WHERE project_id = ? AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1",
        )
        .get(projectId),
    );

  const createRun = ({
    graphId,
    projectId,
    graphSnapshot,
    maxExecutions = DEFAULT_MAX_EXECUTIONS,
    initialState = {},
    id,
  }) => {
    const runId = id ?? randomUUID();
    db()
      .prepare(
        `INSERT INTO agent_graph_runs
           (id, graph_id, project_id, status, current_node_id, state, graph_snapshot, max_executions, error, created_at, started_at, completed_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
      )
      .run(
        runId,
        graphId,
        projectId,
        graphSnapshot.entryNodeId ?? null,
        toJson(initialState),
        toJson(graphSnapshot),
        maxExecutions,
        now(),
      );
    return getRun(runId);
  };

  const updateRun = (runId, patch) => {
    const current = getRun(runId);
    if (!current) {
      return null;
    }
    const merged = { ...current, ...patch };
    db()
      .prepare(
        `UPDATE agent_graph_runs
         SET status = ?, current_node_id = ?, state = ?, error = ?, started_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.status,
        merged.currentNodeId ?? null,
        toJson(merged.state),
        merged.error ?? null,
        merged.startedAt ?? null,
        merged.completedAt ?? null,
        runId,
      );
    return getRun(runId);
  };

  // ── Executions ───────────────────────────────────────────────────────

  const listExecutions = (runId) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_node_executions WHERE run_id = ? ORDER BY sequence",
      )
      .all(runId)
      .map(mapExecution);

  const listExecutionsForNode = (runId, nodeId) =>
    db()
      .prepare(
        "SELECT * FROM agent_graph_node_executions WHERE run_id = ? AND node_id = ? ORDER BY sequence",
      )
      .all(runId, nodeId)
      .map(mapExecution);

  const countExecutions = (runId) =>
    Number(
      db()
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_graph_node_executions WHERE run_id = ?",
        )
        .get(runId)?.count ?? 0,
    );

  const getExecution = (executionId) =>
    mapExecution(
      db()
        .prepare("SELECT * FROM agent_graph_node_executions WHERE id = ?")
        .get(executionId),
    );

  const createExecution = ({
    runId,
    nodeId,
    iteration,
    sequence,
    input,
    id,
  }) => {
    const executionId = id ?? randomUUID();
    db()
      .prepare(
        `INSERT INTO agent_graph_node_executions
           (id, run_id, node_id, iteration, sequence, status, input, output_text, result, chat_id, error, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        executionId,
        runId,
        nodeId,
        iteration,
        sequence,
        toJson(input),
        now(),
      );
    return getExecution(executionId);
  };

  const updateExecution = (executionId, patch) => {
    const current = getExecution(executionId);
    if (!current) {
      return null;
    }
    const merged = { ...current, ...patch };
    db()
      .prepare(
        `UPDATE agent_graph_node_executions
         SET status = ?, output_text = ?, result = ?, chat_id = ?, error = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.status,
        merged.outputText ?? null,
        merged.result === null || merged.result === undefined
          ? null
          : toJson(merged.result),
        merged.chatId ?? null,
        merged.error ?? null,
        merged.completedAt ?? null,
        executionId,
      );
    return getExecution(executionId);
  };

  return {
    countExecutions,
    createExecution,
    createGraph,
    createRun,
    deleteGraph,
    getActiveRunForProject,
    getExecution,
    getGraph,
    getRun,
    listExecutions,
    listExecutionsForNode,
    listGraphs,
    listRuns,
    listProjectRuns,
    listRunsByStatus,
    saveGraphDefinition,
    updateExecution,
    updateGraph,
    updateRun,
  };
};
