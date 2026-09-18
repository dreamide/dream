import { create } from "zustand";
import { GraphApiError, graphsApi } from "@/lib/agent-graphs-api";
import { getDesktopApi } from "@/lib/electron";
import type {
  AgentGraph,
  AgentGraphSummary,
  GraphNodeAgent,
  GraphRun,
  GraphRunEvent,
  GraphValidationResult,
  NodeExecution,
} from "@/types/agent-graphs";
import type { GraphTemplate } from "./graph-templates";

/**
 * Renderer-side state for the workflow graph workspace.
 *
 * The database (via the API) is the source of truth for graphs and runs.
 * This store holds working copies for the editor, the currently observed
 * run, and applies IPC run events by refetching the affected run — events
 * are lossy across reloads so nothing here depends on having seen them all.
 */

export type GraphSelection =
  | { id: string; kind: "node" }
  | { id: string; kind: "edge" }
  | null;

export interface GraphTraversalHighlight {
  at: number;
  edgeId: string;
}

interface GraphWorkspaceState {
  graphsByProject: Record<string, AgentGraphSummary[]>;
  graphsById: Record<string, AgentGraph>;
  selectedGraphIdByProject: Record<string, string | null>;
  validationByGraphId: Record<string, GraphValidationResult>;
  dirtyGraphIds: Record<string, boolean>;
  savingGraphIds: Record<string, boolean>;
  selectionByGraphId: Record<string, GraphSelection>;

  runsByGraphId: Record<string, GraphRun[]>;
  runsById: Record<string, GraphRun>;
  executionsByRunId: Record<string, NodeExecution[]>;
  selectedRunIdByGraphId: Record<string, string | null>;
  selectedExecutionIdByGraphId: Record<string, string | null>;
  traversalByRunId: Record<string, GraphTraversalHighlight | null>;

  loadingProjects: Record<string, boolean>;
  creatingProjects: Record<string, boolean>;
  errorByProject: Record<string, string | null>;

  loadGraphs: (projectId: string) => Promise<void>;
  selectGraph: (projectId: string, graphId: string | null) => void;
  loadGraph: (graphId: string) => Promise<AgentGraph | null>;
  createGraph: (
    projectId: string,
    input: { name: string; template?: GraphTemplate | null },
  ) => Promise<AgentGraph | null>;
  deleteGraph: (projectId: string, graphId: string) => Promise<void>;
  updateGraphMeta: (
    graphId: string,
    patch: { description?: string; name?: string },
  ) => Promise<void>;
  updateGraphDefinition: (
    graphId: string,
    updater: (graph: AgentGraph) => AgentGraph,
  ) => void;
  saveGraph: (graphId: string) => Promise<void>;
  setSelection: (graphId: string, selection: GraphSelection) => void;

  loadRuns: (graphId: string) => Promise<void>;
  loadRun: (runId: string) => Promise<void>;
  selectRun: (graphId: string, runId: string | null) => void;
  selectExecution: (graphId: string, executionId: string | null) => void;
  startRun: (input: {
    defaultAgent: GraphNodeAgent;
    graphId: string;
    projectId: string;
  }) => Promise<GraphRun | null>;
  cancelRun: (runId: string) => Promise<void>;
  resumeRun: (runId: string) => Promise<void>;
  handleEvent: (event: GraphRunEvent) => void;
  setError: (projectId: string, error: string | null) => void;
}

const SAVE_DEBOUNCE_MS = 600;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingRunFetches = new Map<string, Promise<void>>();

const describeError = (error: unknown): string => {
  if (error instanceof GraphApiError) {
    return error.errors.length > 0
      ? error.errors.map((issue) => issue.message).join(" ")
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/** Appends " 2", " 3", … when a graph with the same name already exists. */
const uniqueGraphName = (name: string, existing: AgentGraphSummary[]) => {
  const taken = new Set(
    existing.map((graph) => graph.name.trim().toLowerCase()),
  );
  if (!taken.has(name.trim().toLowerCase())) {
    return name;
  }
  let index = 2;
  while (taken.has(`${name} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${name} ${index}`;
};

const upsertRunInList = (runs: GraphRun[], run: GraphRun): GraphRun[] => {
  const index = runs.findIndex((entry) => entry.id === run.id);
  if (index === -1) {
    return [run, ...runs];
  }
  const next = [...runs];
  next[index] = run;
  return next;
};

export const useGraphStore = create<GraphWorkspaceState>((set, get) => ({
  creatingProjects: {},
  dirtyGraphIds: {},
  errorByProject: {},
  executionsByRunId: {},
  graphsById: {},
  graphsByProject: {},
  loadingProjects: {},
  runsByGraphId: {},
  runsById: {},
  savingGraphIds: {},
  selectedExecutionIdByGraphId: {},
  selectedGraphIdByProject: {},
  selectedRunIdByGraphId: {},
  selectionByGraphId: {},
  traversalByRunId: {},
  validationByGraphId: {},

  setError: (projectId, error) =>
    set((state) => ({
      errorByProject: { ...state.errorByProject, [projectId]: error },
    })),

  loadGraphs: async (projectId) => {
    set((state) => ({
      loadingProjects: { ...state.loadingProjects, [projectId]: true },
    }));
    try {
      const [{ graphs }, { run: activeRun }] = await Promise.all([
        graphsApi.listGraphs(projectId),
        graphsApi.getActiveRun(projectId),
      ]);
      set((state) => {
        const currentSelection = state.selectedGraphIdByProject[projectId];
        const selected =
          currentSelection &&
          graphs.some((graph) => graph.id === currentSelection)
            ? currentSelection
            : (activeRun?.graphId ?? graphs[0]?.id ?? null);
        return {
          errorByProject: { ...state.errorByProject, [projectId]: null },
          graphsByProject: { ...state.graphsByProject, [projectId]: graphs },
          selectedGraphIdByProject: {
            ...state.selectedGraphIdByProject,
            [projectId]: selected,
          },
        };
      });
      const selectedId = get().selectedGraphIdByProject[projectId];
      if (selectedId) {
        await get().loadGraph(selectedId);
        await get().loadRuns(selectedId);
      }
      if (activeRun) {
        get().selectRun(activeRun.graphId, activeRun.id);
        await get().loadRun(activeRun.id);
      }
    } catch (error) {
      get().setError(projectId, describeError(error));
    } finally {
      set((state) => ({
        loadingProjects: { ...state.loadingProjects, [projectId]: false },
      }));
    }
  },

  selectGraph: (projectId, graphId) => {
    set((state) => ({
      selectedGraphIdByProject: {
        ...state.selectedGraphIdByProject,
        [projectId]: graphId,
      },
    }));
    if (graphId) {
      void get().loadGraph(graphId);
      void get().loadRuns(graphId);
    }
  },

  loadGraph: async (graphId) => {
    if (get().dirtyGraphIds[graphId]) {
      return get().graphsById[graphId] ?? null;
    }
    try {
      const { graph, validation } = await graphsApi.getGraph(graphId);
      set((state) => ({
        graphsById: { ...state.graphsById, [graphId]: graph },
        validationByGraphId: {
          ...state.validationByGraphId,
          [graphId]: validation,
        },
      }));
      return graph;
    } catch (error) {
      const projectId = get().graphsById[graphId]?.projectId;
      if (projectId) {
        get().setError(projectId, describeError(error));
      }
      return null;
    }
  },

  createGraph: async (projectId, { name, template }) => {
    // Guard against double submits (double-clicks, repeated key presses).
    if (get().creatingProjects[projectId]) {
      return null;
    }
    set((state) => ({
      creatingProjects: { ...state.creatingProjects, [projectId]: true },
    }));
    try {
      let { graph, validation } = await graphsApi.createGraph({
        description: template?.description ?? "",
        name: uniqueGraphName(name, get().graphsByProject[projectId] ?? []),
        projectId,
      });
      if (template) {
        ({ graph, validation } = await graphsApi.saveGraph({
          edges: template.edges,
          entryNodeId: template.entryNodeId,
          graphId: graph.id,
          nodes: template.nodes,
        }));
      }
      set((state) => ({
        errorByProject: { ...state.errorByProject, [projectId]: null },
        graphsById: { ...state.graphsById, [graph.id]: graph },
        graphsByProject: {
          ...state.graphsByProject,
          [projectId]: [
            graph,
            ...(state.graphsByProject[projectId] ?? []).filter(
              (entry) => entry.id !== graph.id,
            ),
          ],
        },
        selectedGraphIdByProject: {
          ...state.selectedGraphIdByProject,
          [projectId]: graph.id,
        },
        validationByGraphId: {
          ...state.validationByGraphId,
          [graph.id]: validation,
        },
      }));
      return graph;
    } catch (error) {
      get().setError(projectId, describeError(error));
      return null;
    } finally {
      set((state) => ({
        creatingProjects: { ...state.creatingProjects, [projectId]: false },
      }));
    }
  },

  deleteGraph: async (projectId, graphId) => {
    try {
      await graphsApi.deleteGraph(graphId);
      set((state) => {
        const remaining = (state.graphsByProject[projectId] ?? []).filter(
          (graph) => graph.id !== graphId,
        );
        const { [graphId]: _removed, ...graphsById } = state.graphsById;
        return {
          graphsById,
          graphsByProject: { ...state.graphsByProject, [projectId]: remaining },
          selectedGraphIdByProject: {
            ...state.selectedGraphIdByProject,
            [projectId]:
              state.selectedGraphIdByProject[projectId] === graphId
                ? (remaining[0]?.id ?? null)
                : state.selectedGraphIdByProject[projectId],
          },
        };
      });
      const next = get().selectedGraphIdByProject[projectId];
      if (next) {
        void get().loadGraph(next);
        void get().loadRuns(next);
      }
    } catch (error) {
      get().setError(projectId, describeError(error));
    }
  },

  updateGraphMeta: async (graphId, patch) => {
    const current = get().graphsById[graphId];
    if (!current) {
      return;
    }
    try {
      const { graph } = await graphsApi.updateGraph({ graphId, ...patch });
      set((state) => ({
        graphsById: {
          ...state.graphsById,
          [graphId]: { ...(state.graphsById[graphId] ?? graph), ...patch },
        },
        graphsByProject: {
          ...state.graphsByProject,
          [graph.projectId]: (state.graphsByProject[graph.projectId] ?? []).map(
            (entry) => (entry.id === graphId ? { ...entry, ...patch } : entry),
          ),
        },
      }));
    } catch (error) {
      get().setError(current.projectId, describeError(error));
    }
  },

  updateGraphDefinition: (graphId, updater) => {
    const current = get().graphsById[graphId];
    if (!current) {
      return;
    }
    const next = updater(current);
    if (next === current) {
      return;
    }
    set((state) => ({
      dirtyGraphIds: { ...state.dirtyGraphIds, [graphId]: true },
      graphsById: { ...state.graphsById, [graphId]: next },
    }));

    const existing = saveTimers.get(graphId);
    if (existing) {
      clearTimeout(existing);
    }
    saveTimers.set(
      graphId,
      setTimeout(() => {
        saveTimers.delete(graphId);
        void get().saveGraph(graphId);
      }, SAVE_DEBOUNCE_MS),
    );
  },

  saveGraph: async (graphId) => {
    const graph = get().graphsById[graphId];
    if (!graph) {
      return;
    }
    const timer = saveTimers.get(graphId);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(graphId);
    }
    set((state) => ({
      savingGraphIds: { ...state.savingGraphIds, [graphId]: true },
    }));
    try {
      const { graph: saved, validation } = await graphsApi.saveGraph({
        edges: graph.edges,
        entryNodeId: graph.entryNodeId,
        graphId,
        nodes: graph.nodes,
      });
      set((state) => {
        // Keep local edits made while the request was in flight.
        const stillDirty = state.graphsById[graphId] !== graph;
        return {
          dirtyGraphIds: { ...state.dirtyGraphIds, [graphId]: stillDirty },
          errorByProject: { ...state.errorByProject, [saved.projectId]: null },
          graphsById: stillDirty
            ? state.graphsById
            : { ...state.graphsById, [graphId]: saved },
          graphsByProject: {
            ...state.graphsByProject,
            [saved.projectId]: (
              state.graphsByProject[saved.projectId] ?? []
            ).map((entry) =>
              entry.id === graphId
                ? { ...entry, updatedAt: saved.updatedAt }
                : entry,
            ),
          },
          validationByGraphId: {
            ...state.validationByGraphId,
            [graphId]: validation,
          },
        };
      });
    } catch (error) {
      get().setError(graph.projectId, describeError(error));
    } finally {
      set((state) => ({
        savingGraphIds: { ...state.savingGraphIds, [graphId]: false },
      }));
    }
  },

  setSelection: (graphId, selection) =>
    set((state) => ({
      selectionByGraphId: { ...state.selectionByGraphId, [graphId]: selection },
    })),

  loadRuns: async (graphId) => {
    try {
      const { runs } = await graphsApi.listRuns(graphId, 50);
      set((state) => {
        const runsById = { ...state.runsById };
        for (const run of runs) {
          runsById[run.id] = run;
        }
        const currentSelection = state.selectedRunIdByGraphId[graphId];
        const selected =
          currentSelection && runs.some((run) => run.id === currentSelection)
            ? currentSelection
            : (runs[0]?.id ?? null);
        return {
          runsByGraphId: { ...state.runsByGraphId, [graphId]: runs },
          runsById,
          selectedRunIdByGraphId: {
            ...state.selectedRunIdByGraphId,
            [graphId]: selected,
          },
        };
      });
      const selected = get().selectedRunIdByGraphId[graphId];
      if (selected) {
        await get().loadRun(selected);
      }
    } catch (error) {
      const projectId = get().graphsById[graphId]?.projectId;
      if (projectId) {
        get().setError(projectId, describeError(error));
      }
    }
  },

  loadRun: (runId) => {
    const inFlight = pendingRunFetches.get(runId);
    if (inFlight) {
      return inFlight;
    }
    const request = graphsApi
      .getRun(runId)
      .then(({ run, executions }) => {
        set((state) => ({
          executionsByRunId: {
            ...state.executionsByRunId,
            [runId]: executions,
          },
          runsByGraphId: {
            ...state.runsByGraphId,
            [run.graphId]: upsertRunInList(
              state.runsByGraphId[run.graphId] ?? [],
              run,
            ),
          },
          runsById: { ...state.runsById, [runId]: run },
        }));
      })
      .catch((error: unknown) => {
        const projectId = get().runsById[runId]?.projectId;
        if (projectId) {
          get().setError(projectId, describeError(error));
        }
      })
      .finally(() => {
        pendingRunFetches.delete(runId);
      });
    pendingRunFetches.set(runId, request);
    return request;
  },

  selectRun: (graphId, runId) => {
    set((state) => ({
      selectedExecutionIdByGraphId: {
        ...state.selectedExecutionIdByGraphId,
        [graphId]: null,
      },
      selectedRunIdByGraphId: {
        ...state.selectedRunIdByGraphId,
        [graphId]: runId,
      },
    }));
    if (runId) {
      void get().loadRun(runId);
    }
  },

  selectExecution: (graphId, executionId) =>
    set((state) => ({
      selectedExecutionIdByGraphId: {
        ...state.selectedExecutionIdByGraphId,
        [graphId]: executionId,
      },
    })),

  startRun: async ({ defaultAgent, graphId, projectId }) => {
    if (get().dirtyGraphIds[graphId]) {
      await get().saveGraph(graphId);
    }
    try {
      const { run } = await graphsApi.startRun({
        defaultAgent,
        graphId,
        projectId,
      });
      set((state) => ({
        errorByProject: { ...state.errorByProject, [projectId]: null },
        executionsByRunId: { ...state.executionsByRunId, [run.id]: [] },
        runsByGraphId: {
          ...state.runsByGraphId,
          [graphId]: upsertRunInList(state.runsByGraphId[graphId] ?? [], run),
        },
        runsById: { ...state.runsById, [run.id]: run },
        selectedExecutionIdByGraphId: {
          ...state.selectedExecutionIdByGraphId,
          [graphId]: null,
        },
        selectedRunIdByGraphId: {
          ...state.selectedRunIdByGraphId,
          [graphId]: run.id,
        },
      }));
      return run;
    } catch (error) {
      get().setError(projectId, describeError(error));
      return null;
    }
  },

  cancelRun: async (runId) => {
    const current = get().runsById[runId];
    try {
      const { run } = await graphsApi.cancelRun(runId);
      set((state) => ({ runsById: { ...state.runsById, [runId]: run } }));
      void get().loadRun(runId);
    } catch (error) {
      if (current) {
        get().setError(current.projectId, describeError(error));
      }
    }
  },

  resumeRun: async (runId) => {
    const current = get().runsById[runId];
    try {
      const { run } = await graphsApi.resumeRun(runId);
      set((state) => ({ runsById: { ...state.runsById, [runId]: run } }));
      void get().loadRun(runId);
    } catch (error) {
      if (current) {
        get().setError(current.projectId, describeError(error));
      }
    }
  },

  handleEvent: (event) => {
    const { graphId, runId } = event;
    if (event.type === "graph.edge.traversed" && event.edgeId) {
      set((state) => ({
        traversalByRunId: {
          ...state.traversalByRunId,
          [runId]: { at: Date.now(), edgeId: event.edgeId as string },
        },
      }));
    }
    if (event.type === "graph.run.started") {
      set((state) => ({
        selectedExecutionIdByGraphId: {
          ...state.selectedExecutionIdByGraphId,
          [graphId]: null,
        },
        selectedRunIdByGraphId: {
          ...state.selectedRunIdByGraphId,
          [graphId]: runId,
        },
      }));
    }
    void get().loadRun(runId);
  },
}));

let eventUnsubscribe: (() => void) | null = null;

/** Idempotent: wires IPC run events into the store once per renderer. */
export const ensureGraphEventSubscription = () => {
  if (eventUnsubscribe) {
    return;
  }
  const api = getDesktopApi();
  if (!api?.onGraphEvent) {
    return;
  }
  eventUnsubscribe = api.onGraphEvent((event) => {
    useGraphStore.getState().handleEvent(event);
  });
};
