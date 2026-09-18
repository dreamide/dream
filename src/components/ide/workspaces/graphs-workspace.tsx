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
import { GraphSettings } from "./graphs/graph-settings";
import { GraphSidebar } from "./graphs/graph-sidebar";
import {
  ensureGraphEventSubscription,
  type GraphSelection,
  useGraphStore,
} from "./graphs/graph-store";
import {
  createNodeFromPreset,
  createPlanImplementTestReviewTemplate,
  type NodePresetId,
} from "./graphs/graph-templates";
import { GraphToolbar } from "./graphs/graph-toolbar";
import { NodeInspector } from "./graphs/node-inspector";
import { RunDetail } from "./graphs/run-detail";
import { RunDialog, type RunDialogStart } from "./graphs/run-dialog";

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
  const runs = useGraphStore((s) => s.runsByProject[projectId] ?? EMPTY_RUNS);
  const selectedRunId = useGraphStore(
    (s) => s.selectedRunIdByProject[projectId] ?? null,
  );
  const run = useGraphStore((s) =>
    selectedRunId ? (s.runsById[selectedRunId] ?? null) : null,
  );
  const loadRuns = useGraphStore((s) => s.loadRuns);

  const loadGraphs = useGraphStore((s) => s.loadGraphs);
  const selectGraph = useGraphStore((s) => s.selectGraph);
  const createGraph = useGraphStore((s) => s.createGraph);
  const deleteGraph = useGraphStore((s) => s.deleteGraph);
  const updateGraphMeta = useGraphStore((s) => s.updateGraphMeta);
  const updateGraphDefinition = useGraphStore((s) => s.updateGraphDefinition);
  const setSelection = useGraphStore((s) => s.setSelection);
  const selectRun = useGraphStore((s) => s.selectRun);
  const startRun = useGraphStore((s) => s.startRun);
  const setError = useGraphStore((s) => s.setError);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);

  useEffect(() => {
    ensureGraphEventSubscription();
    void loadGraphs(projectId);
    void loadRuns(projectId);
  }, [loadGraphs, loadRuns, projectId]);

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

  const handleAddNode = useCallback(
    (presetId: NodePresetId) => {
      if (!graph) {
        return;
      }
      const maxY = graph.nodes.reduce(
        (max, node) => Math.max(max, node.position.y),
        -180,
      );
      const node = createNodeFromPreset(
        presetId,
        { x: 80, y: maxY + 180 },
        {
          blankName: t("newNodeName", { index: graph.nodes.length + 1 }),
          takenNames: graph.nodes.map((entry) => entry.name),
        },
      );
      handleGraphChange((current) => ({
        ...current,
        entryNodeId: current.entryNodeId ?? node.id,
        nodes: [...current.nodes, node],
      }));
      handleSelectionChange({ id: node.id, kind: "node" });
    },
    [graph, handleGraphChange, handleSelectionChange, t],
  );

  const handleStartRun = useCallback(
    async ({ inputs, task }: RunDialogStart) => {
      if (!graph) {
        return;
      }
      setStarting(true);
      try {
        const startedRun = await startRun({
          defaultAgent: {
            agentMode: "build",
            model: projectAgent.model,
            modelSpeed: projectAgent.modelSpeed,
            provider: projectAgent.provider,
            reasoningEffort: projectAgent.reasoningEffort,
          },
          graphId: graph.id,
          initialState: { ...(task ? { task } : {}), inputs },
          projectId,
        });
        if (startedRun) setHistoryOpen(true);
      } finally {
        setStarting(false);
      }
    },
    [graph, projectAgent, projectId, startRun],
  );

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
  const inspector = graph ? (
    selectedNode ? (
      <NodeInspector
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
        onSetEntry={() =>
          handleGraphChange((current) => ({
            ...current,
            entryNodeId: selectedNode.id,
          }))
        }
      />
    ) : selectedEdge ? (
      <EdgeInspector
        edge={selectedEdge}
        locked={false}
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
        sourceOutputs={
          graph.nodes.find((node) => node.id === selectedEdge.sourceNodeId)
            ?.outputs ?? []
        }
        targetName={nodeNames.get(selectedEdge.targetNodeId) ?? ""}
      />
    ) : (
      <GraphSettings
        graph={graph}
        onInputsChange={(inputs) =>
          handleGraphChange((current) => ({ ...current, inputs }))
        }
      />
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
          selectRun(projectId, runId);
          setHistoryOpen(true);
        }}
        creating={creating}
        loading={loading}
        onCreateBlank={() => {
          setHistoryOpen(false);
          void createGraph(projectId, { name: t("untitledGraph") });
        }}
        onCreateFromTemplate={() => {
          setHistoryOpen(false);
          const template = createPlanImplementTestReviewTemplate();
          void createGraph(projectId, { name: template.name, template });
        }}
        onDelete={(graphId) => {
          void deleteGraph(projectId, graphId);
        }}
        onSelect={(graphId) => {
          setHistoryOpen(false);
          selectGraph(projectId, graphId);
        }}
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

        {historyOpen ? (
          run ? (
            <RunDetail
              key={run.id}
              run={run}
              onBack={() => setHistoryOpen(false)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {t("noRunSelected")}
            </div>
          )
        ) : graph ? (
          <>
            <GraphToolbar
              key={graph.id}
              graph={graph}
              onAddNode={handleAddNode}
              onRename={(name) => {
                void updateGraphMeta(graph.id, { name });
              }}
              onStartRun={() => setRunDialogOpen(true)}
              starting={starting}
              validation={validation}
            />
            <RunDialog
              graphName={graph.name}
              inputs={graph.inputs ?? []}
              key={runDialogOpen ? "open" : "closed"}
              onOpenChange={setRunDialogOpen}
              onStart={(start) => {
                void handleStartRun(start);
              }}
              open={runDialogOpen}
            />
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                {graph.nodes.length === 0 ? (
                  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                    {t("emptyCanvas")}
                  </div>
                ) : (
                  <GraphCanvas
                    key={graph.id}
                    executions={EMPTY_EXECUTIONS}
                    run={null}
                    alwaysLabel={t("always")}
                    elseLabel={t("elseHandle")}
                    graph={graph}
                    inheritLabel={t("inheritProject")}
                    onGraphChange={handleGraphChange}
                    onSelectionChange={handleSelectionChange}
                    selection={selection}
                    traversal={null}
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
