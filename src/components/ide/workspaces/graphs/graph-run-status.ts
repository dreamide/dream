import type {
  GraphEdge,
  GraphRun,
  NodeExecution,
  NodeExecutionStatus,
} from "@/types/agent-graphs";

/** Visual state of a node for the run being observed. */
export type NodeRunVisualState =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "revisited";

export interface NodeRunSummary {
  count: number;
  lastStatus: NodeExecutionStatus | null;
  visual: NodeRunVisualState;
}

export const summarizeNodeRun = (
  nodeId: string,
  run: GraphRun | null,
  executions: NodeExecution[],
): NodeRunSummary => {
  const mine = executions.filter((execution) => execution.nodeId === nodeId);
  const last = mine.at(-1) ?? null;
  const isCurrent =
    run?.status === "running" &&
    (last?.status === "running" || run.currentNodeId === nodeId);

  let visual: NodeRunVisualState = "idle";
  if (isCurrent) {
    visual = "running";
  } else if (last?.status === "failed") {
    visual = "failed";
  } else if (last?.status === "cancelled") {
    visual = "cancelled";
  } else if (last?.status === "completed") {
    visual = mine.length > 1 ? "revisited" : "completed";
  }

  return { count: mine.length, lastStatus: last?.status ?? null, visual };
};

/** Edge ids that were followed at least once in the observed run. */
export const collectTraversedEdgeIds = (
  edges: GraphEdge[],
  executions: NodeExecution[],
): Set<string> => {
  const traversed = new Set<string>();
  for (let index = 0; index < executions.length - 1; index += 1) {
    const from = executions[index];
    const to = executions[index + 1];
    if (from.status !== "completed") {
      continue;
    }
    const match = edges.find(
      (edge) =>
        edge.sourceNodeId === from.nodeId && edge.targetNodeId === to.nodeId,
    );
    if (match) {
      traversed.add(match.id);
    }
  }
  return traversed;
};

export const formatDuration = (
  startedAt: string | null,
  completedAt: string | null,
): string | null => {
  if (!startedAt) {
    return null;
  }
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const ms = Math.max(0, end - Date.parse(startedAt));
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};
