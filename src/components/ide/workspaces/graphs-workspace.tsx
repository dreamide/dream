import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentGraph, GraphEdge, GraphNode } from "@/types/agent-graphs";
import type { ProjectConfig } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "../ide-state";
import { useIdeStore } from "../ide-store";
import { EdgeInspector } from "./graphs/edge-inspector";
import { GraphCanvas } from "./graphs/graph-canvas";
import { GraphSidebar } from "./graphs/graph-sidebar";
import {
  ensureGraphEventSubscription,
  type GraphSelection,
  useGraphStore,
} from "./graphs/graph-store";
import {
  createBlankNode,
  createPlanImplementTestReviewTemplate,
} from "./graphs/graph-templates";
import { GraphToolbar } from "./graphs/graph-toolbar";
import { NodeInspector } from "./graphs/node-inspector";
import { ExecutionDetail, ExecutionList } from "./graphs/run-history";

export interface GraphsWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

const EMPTY_EXECUTIONS: never[] = [];
const EMPTY_RUNS: never[] = [];

const GraphsWorkspaceComponent = ({ project }: GraphsWorkspaceProps) => {
  const t = useTranslations("graphs");
  const projectId = project.id;
  // Select the stored project reference (stable) rather than building a new
  // object per read, which would re-render forever under useSyncExternalStore.
  const storedProject = useIdeStore((s) =>
    s.projects.find((item) => item.id === projectId),
  );
  const currentProject = storedProject ?? project;
  const projectAgent = useMemo(
    () => ({
      model: currentProject.model,
      modelSpeed: currentProject.modelSpeed,
      provider: currentProject.provider,
      reasoningEffort: currentProject.reasoningEffort,
    }),
    [
      currentProject.model,
      currentProject.modelSpeed,
      currentProject.provider,
      currentProject.reasoningEffort,
    ],
  );

  const graphs = useGraphStore(
    (s) => s.graphsByProject[projectId] ?? EMPTY_RUNS,
  );
  const loading = useGraphStore((s) => s.loadingProjects[projectId] ?? false);
  const creating = useGraphStore((s) => s.creatingProjects[projectId] ?? false);
  const error = useGraphStore((s) => s.errorByProject[projectId] ?? null);
  const selectedGraphId = useGraphStore(
    (s) => s.selectedGraphIdByProject[projectId] ?? null,
  );
  const graph = useGraphStore((s) =>
    selectedGraphId ? (s.graphsById[selectedGraphId] ?? null) : null,
  );
  const validation = useGraphStore((s) =>
    selectedGraphId ? (s.validationByGraphId[selectedGraphId] ?? null) : null,
  );
  const selection = useGraphStore((s) =>
    selectedGraphId ? (s.selectionByGraphId[selectedGraphId] ?? null) : null,
  );
  const runs = useGraphStore((s) =>
    selectedGraphId
      ? (s.runsByGraphId[selectedGraphId] ?? EMPTY_RUNS)
      : EMPTY_RUNS,
  );
  const selectedRunId = useGraphStore((s) =>
    selectedGraphId
      ? (s.selectedRunIdByGraphId[selectedGraphId] ?? null)
      : null,
  );
  const run = useGraphStore((s) =>
    selectedRunId ? (s.runsById[selectedRunId] ?? null) : null,
  );
  const executions = useGraphStore((s) =>
    selectedRunId
      ? (s.executionsByRunId[selectedRunId] ?? EMPTY_EXECUTIONS)
      : EMPTY_EXECUTIONS,
  );
  const traversal = useGraphStore((s) =>
    selectedRunId ? (s.traversalByRunId[selectedRunId] ?? null) : null,
  );
  const selectedExecutionId = useGraphStore((s) =>
    selectedGraphId
      ? (s.selectedExecutionIdByGraphId[selectedGraphId] ?? null)
      : null,
  );

  const loadGraphs = useGraphStore((s) => s.loadGraphs);
  const selectGraph = useGraphStore((s) => s.selectGraph);
  const createGraph = useGraphStore((s) => s.createGraph);
  const deleteGraph = useGraphStore((s) => s.deleteGraph);
  const updateGraphMeta = useGraphStore((s) => s.updateGraphMeta);
  const updateGraphDefinition = useGraphStore((s) => s.updateGraphDefinition);
  const setSelection = useGraphStore((s) => s.setSelection);
  const selectRun = useGraphStore((s) => s.selectRun);
  const selectExecution = useGraphStore((s) => s.selectExecution);
  const startRun = useGraphStore((s) => s.startRun);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const resumeRun = useGraphStore((s) => s.resumeRun);
  const setError = useGraphStore((s) => s.setError);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    ensureGraphEventSubscription();
    void loadGraphs(projectId);
  }, [loadGraphs, projectId]);

  const handleGraphChange = useCallback(
    (updater: (graph: AgentGraph) => AgentGraph) => {
      if (selectedGraphId) {
        updateGraphDefinition(selectedGraphId, updater);
      }
    },
    [selectedGraphId, updateGraphDefinition],
  );

  const handleSelectionChange = useCallback(
    (next: GraphSelection) => {
      if (selectedGraphId) {
        setSelection(selectedGraphId, next);
      }
    },
    [selectedGraphId, setSelection],
  );

  const handleAddNode = useCallback(() => {
    if (!graph) {
      return;
    }
    const maxY = graph.nodes.reduce(
      (max, node) => Math.max(max, node.position.y),
      -180,
    );
    const node = createBlankNode(
      t("newNodeName", { index: graph.nodes.length + 1 }),
      { x: 80, y: maxY + 180 },
    );
    handleGraphChange((current) => ({
      ...current,
      entryNodeId: current.entryNodeId ?? node.id,
      nodes: [...current.nodes, node],
    }));
    handleSelectionChange({ id: node.id, kind: "node" });
  }, [graph, handleGraphChange, handleSelectionChange, t]);

  const handleStartRun = useCallback(async () => {
    if (!graph) {
      return;
    }
    setStarting(true);
    try {
      await startRun({
        defaultAgent: {
          agentMode: "build",
          model: projectAgent.model,
          modelSpeed: projectAgent.modelSpeed,
          provider: projectAgent.provider,
          reasoningEffort: projectAgent.reasoningEffort,
        },
        graphId: graph.id,
        projectId,
      });
    } finally {
      setStarting(false);
    }
  }, [graph, projectAgent, projectId, startRun]);

  const nodeNames = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node.name])),
    [graph?.nodes],
  );

  const selectedNode: GraphNode | null =
    selection?.kind === "node"
      ? (graph?.nodes.find((node) => node.id === selection.id) ?? null)
      : null;
  const selectedEdge: GraphEdge | null =
    selection?.kind === "edge"
      ? (graph?.edges.find((edge) => edge.id === selection.id) ?? null)
      : null;
  const selectedExecution =
    executions.find((execution) => execution.id === selectedExecutionId) ??
    null;
  const isRunning = run?.status === "running";

  const inspector = graph ? (
    selectedNode ? (
      <NodeInspector
        executions={executions}
        graph={graph}
        node={selectedNode}
        onChange={(updater) =>
          handleGraphChange((current) => ({
            ...current,
            nodes: current.nodes.map((node) =>
              node.id === selectedNode.id ? updater(node) : node,
            ),
          }))
        }
        onDelete={() => {
          handleGraphChange((current) => ({
            ...current,
            edges: current.edges.filter(
              (edge) =>
                edge.sourceNodeId !== selectedNode.id &&
                edge.targetNodeId !== selectedNode.id,
            ),
            entryNodeId:
              current.entryNodeId === selectedNode.id
                ? (current.nodes.find((node) => node.id !== selectedNode.id)
                    ?.id ?? null)
                : current.entryNodeId,
            nodes: current.nodes.filter((node) => node.id !== selectedNode.id),
          }));
          handleSelectionChange(null);
        }}
        onSelectExecution={(executionId) =>
          selectExecution(graph.id, executionId)
        }
        onSetEntry={() =>
          handleGraphChange((current) => ({
            ...current,
            entryNodeId: selectedNode.id,
          }))
        }
        run={run}
        selectedExecutionId={selectedExecutionId}
      />
    ) : selectedEdge ? (
      <EdgeInspector
        edge={selectedEdge}
        locked={isRunning}
        onChange={(updater) =>
          handleGraphChange((current) => ({
            ...current,
            edges: current.edges.map((edge) =>
              edge.id === selectedEdge.id ? updater(edge) : edge,
            ),
          }))
        }
        onDelete={() => {
          handleGraphChange((current) => ({
            ...current,
            edges: current.edges.filter((edge) => edge.id !== selectedEdge.id),
          }));
          handleSelectionChange(null);
        }}
        sourceName={nodeNames.get(selectedEdge.sourceNodeId) ?? ""}
        targetName={nodeNames.get(selectedEdge.targetNodeId) ?? ""}
      />
    ) : run ? (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          {t("runExecutions")}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {run.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive-surface px-2 py-1.5 text-xs text-destructive">
              {run.error}
            </div>
          ) : null}
          <ExecutionList
            executions={executions}
            nodeNames={nodeNames}
            onSelect={(executionId) => selectExecution(graph.id, executionId)}
            selectedExecutionId={selectedExecutionId}
            showNodeName
          />
          {selectedExecution ? (
            <div className="border-t border-border pt-3">
              <ExecutionDetail
                execution={selectedExecution}
                nodeName={
                  nodeNames.get(selectedExecution.nodeId) ??
                  selectedExecution.nodeId
                }
              />
            </div>
          ) : null}
          {Object.keys(run.state).length > 0 ? (
            <div className="border-t border-border pt-3">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {t("sharedState")}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4">
                {JSON.stringify(run.state, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    ) : (
      <div className="p-3 text-xs text-muted-foreground">{t("selectHint")}</div>
    )
  ) : null;

  return (
    <div className="flex h-full min-h-0" data-project-id={projectId}>
      <GraphSidebar
        graphs={graphs}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={(runId) => {
          if (selectedGraphId) {
            selectRun(selectedGraphId, runId);
            setSelection(selectedGraphId, null);
          }
        }}
        creating={creating}
        loading={loading}
        onCreateBlank={() => {
          void createGraph(projectId, { name: t("untitledGraph") });
        }}
        onCreateFromTemplate={() => {
          const template = createPlanImplementTestReviewTemplate();
          void createGraph(projectId, { name: template.name, template });
        }}
        onDelete={(graphId) => {
          void deleteGraph(projectId, graphId);
        }}
        onSelect={(graphId) => selectGraph(projectId, graphId)}
        selectedGraphId={selectedGraphId}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {error ? (
          <div className="flex items-center gap-2 border-b border-destructive/40 bg-destructive-surface px-3 py-1.5 text-xs text-destructive">
            <span className="min-w-0 flex-1 truncate" title={error}>
              {error}
            </span>
            <Button
              onClick={() => setError(projectId, null)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : null}

        {graph ? (
          <>
            <GraphToolbar
              graph={graph}
              onAddNode={handleAddNode}
              onCancelRun={() => {
                if (run) {
                  void cancelRun(run.id);
                }
              }}
              onRename={(name) => {
                void updateGraphMeta(graph.id, { name });
              }}
              onResumeRun={() => {
                if (run) {
                  void resumeRun(run.id);
                }
              }}
              onStartRun={() => {
                void handleStartRun();
              }}
              run={run}
              starting={starting}
              validation={validation}
            />
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                {graph.nodes.length === 0 ? (
                  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                    {t("emptyCanvas")}
                  </div>
                ) : (
                  <GraphCanvas
                    alwaysLabel={t("always")}
                    executions={executions}
                    graph={graph}
                    inheritLabel={t("inheritProject")}
                    onGraphChange={handleGraphChange}
                    onSelectionChange={handleSelectionChange}
                    run={run}
                    selection={selection}
                    traversal={traversal}
                  />
                )}
              </div>
              <div className="w-88 shrink-0 border-l border-border">
                {inspector}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {loading ? t("loading") : t("noGraphSelected")}
          </div>
        )}
      </div>
    </div>
  );
};

export const GraphsWorkspace = memo(
  GraphsWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
GraphsWorkspace.displayName = "GraphsWorkspace";
