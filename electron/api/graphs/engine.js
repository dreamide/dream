import { emitGraphEvent } from "./events.js";
import { extractNodeResult, extractTaskResult } from "./node-result.js";
import { edgeOutcome, nodeType, resolveOutcomeEdge } from "./outcomes.js";
import {
  buildNodePrompt,
  buildRepairPrompt,
  STEPS_STATE_KEY,
} from "./prompt.js";
import { validateGraph } from "./validation.js";

/**
 * Graph execution engine — a small sequential state machine.
 *
 *   step → execute → { status, message } → follow the ✓ or ✗ edge → next step
 *
 * A step without an edge for its outcome ends the run: completed on success,
 * failed (with the step's message) on failure.
 *
 * Loops are not special-cased: an edge may target any node, including one
 * that already ran. Every visit creates a new execution record.
 *
 * Persistence order after every node (crash safety):
 *   1. execution result  2. state updates  3. next edge  4. currentNodeId
 * Only then does the next node begin.
 *
 * The engine is provider-agnostic. `executor.execute({ prompt, ... })` must
 * return `{ text }` (raw agent output); result extraction, validation and
 * the single repair turn live here.
 */

export class GraphValidationError extends Error {
  constructor(errors, warnings = []) {
    super(errors.map((entry) => entry.message).join(" "));
    this.name = "GraphValidationError";
    this.errors = errors;
    this.warnings = warnings;
  }
}

export class RunConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunConflictError";
  }
}

/** Follow-up turns granted when the result block is missing or invalid. */
const MAX_REPAIR_TURNS = 2;

const isAbortError = (error) =>
  error?.name === "AbortError" || error?.code === "ABORT_ERR";

const errorMessage = (error, fallback) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Records the step's latest result so later steps can see it. */
const recordStepResult = (state, node, result) => ({
  ...(state ?? {}),
  [STEPS_STATE_KEY]: {
    ...(state?.[STEPS_STATE_KEY] ?? {}),
    [node.name]: { message: result.message, status: result.status },
  },
});

const snapshotGraph = (graph, defaultAgent = {}) => ({
  defaultAgent,
  description: graph.description ?? "",
  edges: graph.edges.map((edge) => ({
    id: edge.id,
    outcome: edgeOutcome(edge),
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
  })),
  entryNodeId: graph.entryNodeId,
  graphId: graph.id,
  name: graph.name,
  nodes: graph.nodes.map((node) => ({
    agent: node.agent ?? {},
    id: node.id,
    instructions: node.instructions ?? "",
    maxIterations: node.maxIterations ?? 5,
    name: node.name,
    position: node.position ?? { x: 80, y: 0 },
    type: nodeType(node),
  })),
});

export const createGraphRunner = ({
  repository,
  executor,
  emit = emitGraphEvent,
  getProjectPath = () => null,
  now = () => new Date().toISOString(),
}) => {
  /** runId → { abortController, promise } */
  const activeRuns = new Map();

  const isActive = (runId) => activeRuns.has(runId);

  const emitEvent = (type, payload) => emit({ type, ...payload });

  // ── Run lifecycle helpers ───────────────────────────────────────────

  const finishRun = (run, status, { error = null } = {}) => {
    const updated = repository.updateRun(run.id, {
      completedAt: now(),
      currentNodeId: status === "completed" ? null : run.currentNodeId,
      error,
      status,
    });
    emitEvent(`graph.run.${status}`, {
      error,
      graphId: run.graphId,
      projectId: run.projectId,
      runId: run.id,
    });
    return updated;
  };

  const failExecution = (execution, run, error, status = "failed") => {
    repository.updateExecution(execution.id, {
      completedAt: now(),
      error,
      status,
    });
    emitEvent("graph.node.failed", {
      error,
      executionId: execution.id,
      graphId: run.graphId,
      nodeId: execution.nodeId,
      runId: run.id,
      status,
    });
  };

  // ── Agent invocation with one repair turn ───────────────────────────

  const invokeAgent = async ({
    graph,
    node,
    run,
    execution,
    prompt,
    signal,
  }) => {
    const projectPath = getProjectPath(run.projectId);
    const baseInput = {
      execution,
      graph,
      node,
      projectPath,
      run,
      signal,
    };

    const first = await executor.execute({ ...baseInput, prompt });
    let lastText = String(first?.text ?? "");
    let transcript = lastText;
    // Tasks cannot fail and need no particular format, so they never need a
    // repair turn; decisions must produce a recognizable status.
    const parse =
      nodeType(node) === "task" ? extractTaskResult : extractNodeResult;
    let parsed = parse(lastText);

    for (let turn = 0; !parsed.ok && turn < MAX_REPAIR_TURNS; turn += 1) {
      if (signal.aborted) {
        throw Object.assign(new Error("Run cancelled."), {
          name: "AbortError",
        });
      }
      const repair = await executor.execute({
        ...baseInput,
        prompt: [
          prompt,
          "",
          "## Your previous response",
          lastText.slice(-8_000),
          "",
          buildRepairPrompt(parsed.error),
        ].join("\n"),
        repair: true,
      });
      lastText = String(repair?.text ?? "");
      transcript = `${transcript}\n\n---\n[repair turn]\n${lastText}`;
      parsed = parse(lastText);
    }

    if (parsed.ok) {
      return { result: parsed.result, text: transcript };
    }
    throw new Error(`Malformed workflow result: ${parsed.error}`);
  };

  // ── Main loop ───────────────────────────────────────────────────────

  const executeLoop = async (runId, abortController) => {
    const { signal } = abortController;
    let run = repository.getRun(runId);
    if (!run) {
      return;
    }

    const graph = run.graphSnapshot;
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    let nodeId = run.currentNodeId ?? graph.entryNodeId;
    let incomingExecution = null;

    // When resuming, seed the "incoming" context from the last completed
    // execution so the next node still sees what led to it.
    const priorExecutions = repository.listExecutions(runId);
    const lastCompleted = [...priorExecutions]
      .reverse()
      .find((entry) => entry.status === "completed");
    if (lastCompleted) {
      incomingExecution = lastCompleted;
    }

    while (nodeId) {
      run = repository.getRun(runId);
      if (!run || run.status === "cancelled" || signal.aborted) {
        if (run && run.status !== "cancelled") {
          finishRun(run, "cancelled");
        }
        return;
      }

      const node = nodesById.get(nodeId);
      if (!node) {
        finishRun(run, "failed", {
          error: `Node ${nodeId} does not exist in the run's graph snapshot.`,
        });
        return;
      }

      const totalExecutions = repository.countExecutions(runId);
      if (totalExecutions >= run.maxExecutions) {
        finishRun(run, "failed", {
          error: `Maximum of ${run.maxExecutions} node executions reached for this run.`,
        });
        return;
      }

      const previousExecutions = repository.listExecutionsForNode(
        runId,
        node.id,
      );
      if (previousExecutions.length >= (node.maxIterations ?? 5)) {
        finishRun(run, "failed", {
          error: `Node "${node.name}" reached its maximum of ${node.maxIterations ?? 5} iterations.`,
        });
        return;
      }

      const incomingNode = incomingExecution
        ? nodesById.get(incomingExecution.nodeId)
        : null;
      const prompt = buildNodePrompt({
        graph,
        incomingExecution,
        incomingNodeName: incomingNode?.name ?? null,
        node,
        previousExecutions,
        state: run.state,
      });

      const execution = repository.createExecution({
        input: { prompt, stateSnapshot: run.state },
        iteration: previousExecutions.length + 1,
        nodeId: node.id,
        runId,
        sequence: totalExecutions + 1,
      });
      emitEvent("graph.node.started", {
        executionId: execution.id,
        graphId: run.graphId,
        iteration: execution.iteration,
        nodeId: node.id,
        runId,
      });

      let outcome;
      try {
        outcome = await invokeAgent({
          execution,
          graph,
          node,
          prompt,
          run,
          signal,
        });
      } catch (error) {
        const latest = repository.getRun(runId);
        const cancelled =
          signal.aborted ||
          isAbortError(error) ||
          latest?.status === "cancelled";
        if (cancelled) {
          failExecution(execution, run, "Cancelled.", "cancelled");
          if (latest && latest.status !== "cancelled") {
            finishRun(latest, "cancelled");
          }
          return;
        }
        const message = errorMessage(error, "Node execution failed.");
        failExecution(execution, run, message);
        finishRun(run, "failed", { error: message });
        return;
      }

      // Cancellation requested while the agent was working: honour it now
      // rather than persisting a transition the user no longer wants.
      const latestRun = repository.getRun(runId);
      if (signal.aborted || latestRun?.status === "cancelled") {
        failExecution(execution, run, "Cancelled.", "cancelled");
        if (latestRun && latestRun.status !== "cancelled") {
          finishRun(latestRun, "cancelled");
        }
        return;
      }

      // 1. persist execution result
      const completedExecution = repository.updateExecution(execution.id, {
        completedAt: now(),
        outputText: outcome.text,
        result: outcome.result,
        status: "completed",
      });

      // 2. merge state, 3. resolve edge, 4. persist next position
      const nextState = recordStepResult(run.state, node, outcome.result);
      const edge = resolveOutcomeEdge({
        edges: graph.edges,
        nodeId: node.id,
        nodesById,
        status: outcome.result.status,
      });
      run = repository.updateRun(runId, {
        currentNodeId: edge ? edge.targetNodeId : null,
        state: nextState,
      });

      emitEvent("graph.node.completed", {
        executionId: execution.id,
        graphId: run.graphId,
        iteration: execution.iteration,
        nodeId: node.id,
        runId,
        summary: outcome.result.summary,
      });

      if (!edge) {
        // Nothing connected to this outcome: the run ends here.
        if (outcome.result.status === "failure") {
          finishRun(run, "failed", {
            error: `Step "${node.name}" failed: ${outcome.result.message || "no details were reported."}`,
          });
        } else {
          finishRun(run, "completed");
        }
        return;
      }

      emitEvent("graph.edge.traversed", {
        edgeId: edge.id,
        executionId: execution.id,
        graphId: run.graphId,
        runId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
      });

      incomingExecution = completedExecution;
      nodeId = edge.targetNodeId;
    }

    finishRun(run, "completed");
  };

  const launch = (runId) => {
    const abortController = new AbortController();
    const promise = executeLoop(runId, abortController)
      .catch((error) => {
        console.error(`[graphs] run ${runId} crashed:`, error);
        const run = repository.getRun(runId);
        if (run && (run.status === "running" || run.status === "pending")) {
          finishRun(run, "failed", {
            error: errorMessage(error, "Run crashed."),
          });
        }
      })
      .finally(() => {
        activeRuns.delete(runId);
      });
    activeRuns.set(runId, { abortController, promise });
    return promise;
  };

  // ── Public API ──────────────────────────────────────────────────────

  const startRun = ({
    graphId,
    projectId,
    maxExecutions,
    initialState,
    defaultAgent = {},
  }) => {
    const graph = repository.getGraph(graphId);
    if (!graph) {
      throw new Error("Graph not found.");
    }
    if (graph.projectId !== projectId) {
      throw new Error("Graph does not belong to this project.");
    }

    const { errors, warnings } = validateGraph(graph);
    if (errors.length > 0) {
      throw new GraphValidationError(errors, warnings);
    }

    const active = repository.getActiveRunForProject(projectId);
    if (active) {
      throw new RunConflictError(
        "Another workflow run is already active for this project.",
      );
    }

    const created = repository.createRun({
      graphId,
      graphSnapshot: snapshotGraph(graph, defaultAgent),
      initialState,
      maxExecutions,
      projectId,
    });
    const run = repository.updateRun(created.id, {
      startedAt: now(),
      status: "running",
    });
    emitEvent("graph.run.started", {
      graphId,
      projectId,
      runId: run.id,
    });

    const promise = launch(run.id);
    return { promise, run, warnings };
  };

  /**
   * Continues a run from its persisted `currentNodeId`. Works for runs that
   * were interrupted (e.g. by an app restart) and marked failed.
   */
  const resumeRun = (runId) => {
    const run = repository.getRun(runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    if (isActive(runId)) {
      throw new RunConflictError("Run is already active.");
    }
    if (run.status === "completed" || run.status === "cancelled") {
      throw new RunConflictError(`Run is already ${run.status}.`);
    }
    if (!run.currentNodeId) {
      throw new Error("Run has no current node to resume from.");
    }
    const active = repository.getActiveRunForProject(run.projectId);
    if (active && active.id !== runId) {
      throw new RunConflictError(
        "Another workflow run is already active for this project.",
      );
    }

    const resumed = repository.updateRun(runId, {
      completedAt: null,
      error: null,
      startedAt: run.startedAt ?? now(),
      status: "running",
    });
    emitEvent("graph.run.started", {
      graphId: resumed.graphId,
      projectId: resumed.projectId,
      resumed: true,
      runId,
    });
    const promise = launch(runId);
    return { promise, run: resumed };
  };

  const cancelRun = (runId) => {
    const run = repository.getRun(runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    if (run.status !== "running" && run.status !== "pending") {
      return run;
    }

    const active = activeRuns.get(runId);
    // Persist first so the loop observes the cancellation even if the
    // abort signal is ignored by a provider.
    const cancelled = finishRun(run, "cancelled");
    active?.abortController.abort();
    return cancelled;
  };

  /**
   * Marks runs left in `running` by a previous process as failed. Called at
   * startup; they can be picked up again with `resumeRun`.
   */
  const recoverInterruptedRuns = () => {
    const interrupted = repository.listRunsByStatus("running");
    for (const run of interrupted) {
      if (isActive(run.id)) {
        continue;
      }
      const executions = repository.listExecutions(run.id);
      for (const execution of executions) {
        if (execution.status === "running") {
          repository.updateExecution(execution.id, {
            completedAt: now(),
            error: "Interrupted by application restart.",
            status: "failed",
          });
        }
      }
      repository.updateRun(run.id, {
        completedAt: now(),
        error: "Interrupted by application restart.",
        status: "failed",
      });
    }
    return interrupted.length;
  };

  const waitForRun = (runId) =>
    activeRuns.get(runId)?.promise ?? Promise.resolve();

  const stopAll = () => {
    for (const [runId] of activeRuns) {
      try {
        cancelRun(runId);
      } catch {
        // ignore
      }
    }
  };

  return {
    cancelRun,
    isActive,
    recoverInterruptedRuns,
    resumeRun,
    startRun,
    stopAll,
    waitForRun,
  };
};
