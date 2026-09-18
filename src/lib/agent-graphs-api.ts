import type {
  AgentGraph,
  AgentGraphSummary,
  GraphEdge,
  GraphNode,
  GraphNodeAgent,
  GraphRun,
  GraphValidationIssue,
  GraphValidationResult,
  NodeExecution,
} from "@/types/agent-graphs";

/**
 * Thin typed client for the agent graph API (`electron/api/graph-routes.js`).
 * All endpoints are POST with JSON bodies, matching Dream's other routes.
 */

export class GraphApiError extends Error {
  status: number;
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];

  constructor(
    message: string,
    status: number,
    details?: {
      errors?: GraphValidationIssue[];
      warnings?: GraphValidationIssue[];
    },
  ) {
    super(message);
    this.name = "GraphApiError";
    this.status = status;
    this.errors = details?.errors ?? [];
    this.warnings = details?.warnings ?? [];
  }
}

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json().catch(() => null)) as {
        errors?: GraphValidationIssue[];
        message?: string;
        warnings?: GraphValidationIssue[];
      } | null;
      throw new GraphApiError(
        payload?.message ?? `Request failed (${response.status}).`,
        response.status,
        payload ?? undefined,
      );
    }
    const text = await response.text().catch(() => "");
    throw new GraphApiError(
      text || `Request failed (${response.status}).`,
      response.status,
    );
  }

  return (await response.json()) as T;
};

export interface GraphWithValidation {
  graph: AgentGraph;
  validation: GraphValidationResult;
}

export const graphsApi = {
  cancelRun: (runId: string) =>
    post<{ run: GraphRun }>("/api/graph-runs/cancel", { runId }),

  createGraph: (input: {
    description?: string;
    name: string;
    projectId: string;
  }) => post<GraphWithValidation>("/api/graphs/create", input),

  deleteGraph: (graphId: string) =>
    post<{ deleted: boolean }>("/api/graphs/delete", { graphId }),

  getActiveRun: (projectId: string) =>
    post<{ run: GraphRun | null }>("/api/graph-runs/active", { projectId }),

  getGraph: (graphId: string) =>
    post<GraphWithValidation>("/api/graphs/get", { graphId }),

  getRun: (runId: string) =>
    post<{ executions: NodeExecution[]; run: GraphRun }>(
      "/api/graph-runs/get",
      { runId },
    ),

  listGraphs: (projectId: string) =>
    post<{ graphs: AgentGraphSummary[] }>("/api/graphs/list", { projectId }),

  listRuns: (graphId: string, limit?: number) =>
    post<{ runs: GraphRun[] }>("/api/graph-runs/list", { graphId, limit }),

  listProjectRuns: (projectId: string) =>
    post<{ runs: GraphRun[] }>("/api/graph-runs/list", {
      projectId,
      limit: 200,
    }),

  resumeRun: (runId: string) =>
    post<{ run: GraphRun }>("/api/graph-runs/resume", { runId }),

  saveGraph: (input: {
    edges: GraphEdge[];
    entryNodeId: string | null;
    graphId: string;
    nodes: GraphNode[];
  }) => post<GraphWithValidation>("/api/graphs/save", input),

  startRun: (input: {
    defaultAgent: GraphNodeAgent;
    graphId: string;
    initialState?: Record<string, unknown>;
    maxExecutions?: number;
    projectId: string;
  }) =>
    post<{ run: GraphRun; warnings: GraphValidationIssue[] }>(
      "/api/graph-runs/start",
      input,
    ),

  updateGraph: (input: {
    description?: string;
    graphId: string;
    name?: string;
  }) => post<GraphWithValidation>("/api/graphs/update", input),
};
