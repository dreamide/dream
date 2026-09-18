import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeChange,
  type EdgeTypes,
  MarkerType,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { nanoid } from "nanoid";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentGraph,
  EdgeCondition,
  GraphRun,
  NodeExecution,
} from "@/types/agent-graphs";
import { getProviderLabel } from "../../ide-types";
import { type AgentFlowNode, AgentNode } from "./agent-node";
import { ConditionEdge, type ConditionFlowEdge } from "./condition-edge";
import { collectTraversedEdgeIds, summarizeNodeRun } from "./graph-run-status";
import type { GraphSelection, GraphTraversalHighlight } from "./graph-store";

import "@xyflow/react/dist/style.css";

const NODE_TYPES: NodeTypes = { agent: AgentNode };
const EDGE_TYPES: EdgeTypes = { condition: ConditionEdge };
const HIGHLIGHT_MS = 1_800;

export const formatCondition = (
  condition: EdgeCondition | null,
  alwaysLabel: string,
): string => {
  if (!condition) {
    return alwaysLabel;
  }
  const value =
    typeof condition.value === "string"
      ? JSON.stringify(condition.value)
      : String(condition.value ?? "");
  switch (condition.operator) {
    case "eq":
      return `${condition.field} == ${value}`;
    case "neq":
      return `${condition.field} != ${value}`;
    case "exists":
      return `${condition.field} exists`;
    case "not_exists":
      return `${condition.field} missing`;
    case "contains":
      return `${condition.field} ∋ ${value}`;
    default:
      return condition.field;
  }
};

export interface GraphCanvasProps {
  alwaysLabel: string;
  executions: NodeExecution[];
  graph: AgentGraph;
  inheritLabel: string;
  onGraphChange: (updater: (graph: AgentGraph) => AgentGraph) => void;
  onSelectionChange: (selection: GraphSelection) => void;
  run: GraphRun | null;
  selection: GraphSelection;
  traversal: GraphTraversalHighlight | null;
}

const GraphCanvasInner = ({
  alwaysLabel,
  executions,
  graph,
  inheritLabel,
  onGraphChange,
  onSelectionChange,
  run,
  selection,
  traversal,
}: GraphCanvasProps) => {
  const { resolvedTheme } = useTheme();
  const [highlightEdgeId, setHighlightEdgeId] = useState<string | null>(null);

  useEffect(() => {
    if (!traversal) {
      setHighlightEdgeId(null);
      return;
    }
    const remaining = HIGHLIGHT_MS - (Date.now() - traversal.at);
    if (remaining <= 0) {
      setHighlightEdgeId(null);
      return;
    }
    setHighlightEdgeId(traversal.edgeId);
    const timer = setTimeout(() => setHighlightEdgeId(null), remaining);
    return () => clearTimeout(timer);
  }, [traversal]);

  const positionsById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.position])),
    [graph.nodes],
  );

  const nodes = useMemo<AgentFlowNode[]>(
    () =>
      graph.nodes.map((node) => {
        const agentLabel = node.agent.provider
          ? `${getProviderLabel(node.agent.provider)}${
              node.agent.model ? ` · ${node.agent.model}` : ""
            }`
          : inheritLabel;
        return {
          data: {
            agentLabel,
            isEntry: graph.entryNodeId === node.id,
            name: node.name,
            run: summarizeNodeRun(node.id, run, executions),
          },
          id: node.id,
          position: node.position,
          selected: selection?.kind === "node" && selection.id === node.id,
          type: "agent",
        };
      }),
    [executions, graph.entryNodeId, graph.nodes, inheritLabel, run, selection],
  );

  const traversedEdgeIds = useMemo(
    () => collectTraversedEdgeIds(graph.edges, executions),
    [executions, graph.edges],
  );

  const edges = useMemo<ConditionFlowEdge[]>(
    () =>
      graph.edges.map((edge) => {
        const sourceY = positionsById.get(edge.sourceNodeId)?.y ?? 0;
        const targetY = positionsById.get(edge.targetNodeId)?.y ?? 0;
        return {
          data: {
            highlighted: highlightEdgeId === edge.id,
            isBackward: targetY <= sourceY,
            isFallback: edge.condition === null,
            label: formatCondition(edge.condition, alwaysLabel),
            traversed: traversedEdgeIds.has(edge.id),
          },
          id: edge.id,
          markerEnd: { type: MarkerType.ArrowClosed },
          selected: selection?.kind === "edge" && selection.id === edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          type: "condition",
        };
      }),
    [
      alwaysLabel,
      graph.edges,
      highlightEdgeId,
      positionsById,
      selection,
      traversedEdgeIds,
    ],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      const removed = new Set<string>();
      const moved = new Map<string, { x: number; y: number }>();
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moved.set(change.id, change.position);
        } else if (change.type === "remove") {
          removed.add(change.id);
        } else if (change.type === "select") {
          if (change.selected) {
            onSelectionChange({ id: change.id, kind: "node" });
          } else if (selection?.kind === "node" && selection.id === change.id) {
            onSelectionChange(null);
          }
        }
      }
      if (removed.size === 0 && moved.size === 0) {
        return;
      }
      onGraphChange((current) => {
        const remainingNodes = current.nodes
          .filter((node) => !removed.has(node.id))
          .map((node) => {
            const position = moved.get(node.id);
            return position ? { ...node, position } : node;
          });
        const remainingEdges =
          removed.size > 0
            ? current.edges.filter(
                (edge) =>
                  !removed.has(edge.sourceNodeId) &&
                  !removed.has(edge.targetNodeId),
              )
            : current.edges;
        const entryNodeId =
          current.entryNodeId && removed.has(current.entryNodeId)
            ? (remainingNodes[0]?.id ?? null)
            : current.entryNodeId;
        return {
          ...current,
          edges: remainingEdges,
          entryNodeId,
          nodes: remainingNodes,
        };
      });
      if (selection?.kind === "node" && removed.has(selection.id)) {
        onSelectionChange(null);
      }
    },
    [onGraphChange, onSelectionChange, selection],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<ConditionFlowEdge>[]) => {
      const removed = new Set<string>();
      for (const change of changes) {
        if (change.type === "remove") {
          removed.add(change.id);
        } else if (change.type === "select") {
          if (change.selected) {
            onSelectionChange({ id: change.id, kind: "edge" });
          } else if (selection?.kind === "edge" && selection.id === change.id) {
            onSelectionChange(null);
          }
        }
      }
      if (removed.size === 0) {
        return;
      }
      onGraphChange((current) => ({
        ...current,
        edges: current.edges.filter((edge) => !removed.has(edge.id)),
      }));
      if (selection?.kind === "edge" && removed.has(selection.id)) {
        onSelectionChange(null);
      }
    },
    [onGraphChange, onSelectionChange, selection],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      const edgeId = nanoid();
      onGraphChange((current) => {
        const hasFallback = current.edges.some(
          (edge) =>
            edge.sourceNodeId === connection.source && edge.condition === null,
        );
        return {
          ...current,
          edges: [
            ...current.edges,
            {
              // A second unconditional edge would be invalid; seed a
              // condition the user can refine instead.
              condition: hasFallback
                ? { field: "status", operator: "eq", value: "" }
                : null,
              id: edgeId,
              priority: current.edges.filter(
                (edge) => edge.sourceNodeId === connection.source,
              ).length,
              sourceNodeId: connection.source,
              targetNodeId: connection.target,
            },
          ],
        };
      });
      onSelectionChange({ id: edgeId, kind: "edge" });
    },
    [onGraphChange, onSelectionChange],
  );

  return (
    <ReactFlow
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      deleteKeyCode={["Backspace", "Delete"]}
      edgeTypes={EDGE_TYPES}
      edges={edges}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
      minZoom={0.2}
      nodeTypes={NODE_TYPES}
      nodes={nodes}
      onConnect={handleConnect}
      onEdgesChange={handleEdgesChange}
      onNodesChange={handleNodesChange}
      onPaneClick={() => onSelectionChange(null)}
      proOptions={{ hideAttribution: true }}
      snapGrid={[10, 10]}
      snapToGrid
    >
      <Background gap={20} size={1} variant={BackgroundVariant.Dots} />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
};

export const GraphCanvas = (props: GraphCanvasProps) => (
  <ReactFlowProvider>
    <GraphCanvasInner {...props} />
  </ReactFlowProvider>
);
