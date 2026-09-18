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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentGraph, GraphRun, NodeExecution } from "@/types/agent-graphs";
import { getProviderLabel } from "../../ide-types";
import { type AgentFlowNode, AgentNode } from "./agent-node";
import { ConditionEdge, type ConditionFlowEdge } from "./condition-edge";
import { edgeOutcome, outcomeFromHandle } from "./graph-conditions";
import { collectTraversedEdgeIds, summarizeNodeRun } from "./graph-run-status";
import type { GraphSelection, GraphTraversalHighlight } from "./graph-store";

import "@xyflow/react/dist/style.css";

const NODE_TYPES: NodeTypes = { agent: AgentNode };
const EDGE_TYPES: EdgeTypes = { condition: ConditionEdge };
const HIGHLIGHT_MS = 1_800;

export interface GraphCanvasProps {
  readOnly?: boolean;
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
  readOnly = false,
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
  const taskNodeIds = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter((node) => node.type === "task")
          .map((node) => node.id),
      ),
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
            kind: node.type === "task" ? "task" : "decision",
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
            outcome: edgeOutcome(edge),
            plain: taskNodeIds.has(edge.sourceNodeId),
            traversed: traversedEdgeIds.has(edge.id),
          },
          id: edge.id,
          markerEnd: { type: MarkerType.ArrowClosed },
          selected: selection?.kind === "edge" && selection.id === edge.id,
          source: edge.sourceNodeId,
          sourceHandle: taskNodeIds.has(edge.sourceNodeId)
            ? "success"
            : edgeOutcome(edge),
          target: edge.targetNodeId,
          type: "condition",
        };
      }),
    [
      graph.edges,
      highlightEdgeId,
      positionsById,
      selection,
      taskNodeIds,
      traversedEdgeIds,
    ],
  );

  // Clicking B while A is selected arrives as one batch ("select B",
  // "deselect A"), and switching between a node and an edge arrives as two
  // callbacks in the same tick. Track the latest selection synchronously so a
  // trailing "deselect" of the old item never clears the new one.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const applySelectionChanges = useCallback(
    (
      kind: "node" | "edge",
      selectedId: string | null,
      deselected: Set<string>,
    ) => {
      const current = selectionRef.current;
      let next = current;
      if (selectedId) {
        next = { id: selectedId, kind };
      } else if (current?.kind === kind && deselected.has(current.id)) {
        next = null;
      }
      if (next !== current) {
        selectionRef.current = next;
        onSelectionChange(next);
      }
    },
    [onSelectionChange],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      const removed = new Set<string>();
      const moved = new Map<string, { x: number; y: number }>();
      let selectedId: string | null = null;
      const deselected = new Set<string>();
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moved.set(change.id, change.position);
        } else if (change.type === "remove") {
          removed.add(change.id);
        } else if (change.type === "select") {
          if (change.selected) {
            selectedId = change.id;
          } else {
            deselected.add(change.id);
          }
        }
      }
      applySelectionChanges("node", selectedId, deselected);
      if (readOnly || (removed.size === 0 && moved.size === 0)) {
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
    [
      applySelectionChanges,
      onGraphChange,
      onSelectionChange,
      selection,
      readOnly,
    ],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<ConditionFlowEdge>[]) => {
      const removed = new Set<string>();
      let selectedId: string | null = null;
      const deselected = new Set<string>();
      for (const change of changes) {
        if (change.type === "remove") {
          removed.add(change.id);
        } else if (change.type === "select") {
          if (change.selected) {
            selectedId = change.id;
          } else {
            deselected.add(change.id);
          }
        }
      }
      applySelectionChanges("edge", selectedId, deselected);
      if (readOnly || removed.size === 0) {
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
    [
      applySelectionChanges,
      onGraphChange,
      onSelectionChange,
      selection,
      readOnly,
    ],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target) {
        return;
      }
      const edgeId = nanoid();
      const outcome = outcomeFromHandle(connection.sourceHandle);
      // One connection per outcome: a new one replaces the old one.
      onGraphChange((current) => ({
        ...current,
        edges: [
          ...current.edges.filter(
            (edge) =>
              edge.sourceNodeId !== connection.source ||
              edgeOutcome(edge) !== outcome,
          ),
          {
            id: edgeId,
            outcome,
            sourceNodeId: connection.source,
            targetNodeId: connection.target,
          },
        ],
      }));
      onSelectionChange({ id: edgeId, kind: "edge" });
    },
    [onGraphChange, onSelectionChange, readOnly],
  );

  return (
    <ReactFlow
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      edgesReconnectable={!readOnly}
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
