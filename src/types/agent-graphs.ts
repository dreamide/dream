import type { AgentMode, AiProvider, ModelSpeed, ReasoningEffort } from "./ide";

/**
 * Agent graph domain types (renderer side). Mirrors the server contract in
 * `electron/api/graphs/*`.
 *
 *   Graph = desired process · Run = one execution · Node execution = one agent turn
 */

/** Every step ends in one of two outcomes; every edge leaves through one. */
export type StepOutcome = "success" | "failure";

export interface GraphNodeAgent {
  agentMode?: AgentMode;
  model?: string;
  modelSpeed?: ModelSpeed;
  provider?: AiProvider;
  reasoningEffort?: ReasoningEffort | null;
}

/**
 * task     — does work and always continues (one exit)
 * decision — reports success or failure (two exits)
 */
export type GraphNodeType = "task" | "decision";

export interface GraphNode {
  agent: GraphNodeAgent;
  graphId?: string;
  id: string;
  instructions: string;
  maxIterations: number;
  name: string;
  position: { x: number; y: number };
  sortOrder?: number;
  type: GraphNodeType;
}

export interface GraphEdge {
  /** Only present on run snapshots recorded by earlier versions. */
  condition?: { value?: unknown } | null;
  graphId?: string;
  id: string;
  outcome?: StepOutcome;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface AgentGraphSummary {
  createdAt: string;
  description: string;
  entryNodeId: string | null;
  id: string;
  name: string;
  projectId: string;
  updatedAt: string;
}

export interface AgentGraph extends AgentGraphSummary {
  edges: GraphEdge[];
  nodes: GraphNode[];
}

export interface GraphValidationIssue {
  code: string;
  edgeId?: string;
  message: string;
  nodeId?: string;
}

export interface GraphValidationResult {
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
}

export type GraphRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface GraphSnapshot {
  defaultAgent: GraphNodeAgent;
  description: string;
  edges: GraphEdge[];
  entryNodeId: string | null;
  graphId: string;
  name: string;
  nodes: Array<
    Omit<GraphNode, "position"> & { position?: GraphNode["position"] }
  >;
}

export interface GraphRun {
  completedAt: string | null;
  createdAt: string;
  currentNodeId: string | null;
  error: string | null;
  graphId: string;
  graphSnapshot: GraphSnapshot;
  id: string;
  maxExecutions: number;
  projectId: string;
  startedAt: string | null;
  state: Record<string, unknown>;
  status: GraphRunStatus;
}

export type NodeExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface NodeResultArtifact {
  description?: string;
  kind: string;
  path: string;
}

export interface NodeResult {
  artifacts?: NodeResultArtifact[];
  data: Record<string, unknown>;
  message?: string;
  stateUpdates?: Record<string, unknown>;
  status?: StepOutcome;
  summary: string;
}

export interface NodeExecution {
  chatId: string | null;
  completedAt: string | null;
  error: string | null;
  id: string;
  input: { prompt?: string; stateSnapshot?: Record<string, unknown> };
  iteration: number;
  nodeId: string;
  outputText: string | null;
  result: NodeResult | null;
  runId: string;
  sequence: number;
  startedAt: string | null;
  status: NodeExecutionStatus;
}

export type GraphRunEventType =
  | "graph.run.started"
  | "graph.run.completed"
  | "graph.run.failed"
  | "graph.run.cancelled"
  | "graph.node.started"
  | "graph.node.completed"
  | "graph.node.failed"
  | "graph.edge.traversed";

export interface GraphRunEvent {
  edgeId?: string;
  error?: string | null;
  executionId?: string;
  graphId: string;
  iteration?: number;
  nodeId?: string;
  projectId?: string;
  resumed?: boolean;
  runId: string;
  sourceNodeId?: string;
  status?: NodeExecutionStatus;
  summary?: string;
  targetNodeId?: string;
  timestamp: string;
  type: GraphRunEventType;
}
