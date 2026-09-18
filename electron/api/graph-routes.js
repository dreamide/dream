import { GraphValidationError, RunConflictError } from "./graphs/engine.js";
import { getGraphRepository, getGraphRunner } from "./graphs/runtime.js";
import {
  activeRunRequestSchema,
  createGraphRequestSchema,
  deleteGraphRequestSchema,
  getGraphRequestSchema,
  listGraphsRequestSchema,
  listRunsRequestSchema,
  runIdRequestSchema,
  saveGraphRequestSchema,
  startRunRequestSchema,
  updateGraphRequestSchema,
} from "./graphs/schemas.js";
import { validateGraph } from "./graphs/validation.js";

const handleGraphRequest = async (c, schema, handler) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  try {
    const result = await handler(parsed.data);
    if (result === null || result === undefined) {
      return c.text("Not found.", 404);
    }
    return c.json(result);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      return c.json(
        {
          errors: error.errors,
          message: error.message,
          warnings: error.warnings,
        },
        422,
      );
    }
    if (error instanceof RunConflictError) {
      return c.text(error.message, 409);
    }
    const message =
      error instanceof Error ? error.message : "Graph request failed.";
    return c.text(message, 400);
  }
};

const withValidation = (graph) =>
  graph ? { graph, validation: validateGraph(graph) } : null;

export const registerGraphRoutes = (app) => {
  const repository = () => getGraphRepository();

  app.post("/api/graphs/list", (c) =>
    handleGraphRequest(c, listGraphsRequestSchema, ({ projectId }) => ({
      graphs: repository().listGraphs(projectId),
    })),
  );

  app.post("/api/graphs/get", (c) =>
    handleGraphRequest(c, getGraphRequestSchema, ({ graphId }) =>
      withValidation(repository().getGraph(graphId)),
    ),
  );

  app.post("/api/graphs/create", (c) =>
    handleGraphRequest(c, createGraphRequestSchema, (data) =>
      withValidation(repository().createGraph(data)),
    ),
  );

  app.post("/api/graphs/update", (c) =>
    handleGraphRequest(c, updateGraphRequestSchema, ({ graphId, ...patch }) =>
      withValidation(repository().updateGraph(graphId, patch)),
    ),
  );

  app.post("/api/graphs/delete", (c) =>
    handleGraphRequest(c, deleteGraphRequestSchema, ({ graphId }) => ({
      deleted: repository().deleteGraph(graphId),
    })),
  );

  app.post("/api/graphs/save", (c) =>
    handleGraphRequest(
      c,
      saveGraphRequestSchema,
      ({ graphId, ...definition }) =>
        withValidation(repository().saveGraphDefinition(graphId, definition)),
    ),
  );

  app.post("/api/graph-runs/start", (c) =>
    handleGraphRequest(c, startRunRequestSchema, (data) => {
      const { run, warnings } = getGraphRunner().startRun(data);
      return { run, warnings };
    }),
  );

  app.post("/api/graph-runs/get", (c) =>
    handleGraphRequest(c, runIdRequestSchema, ({ runId }) => {
      const run = repository().getRun(runId);
      return run
        ? { executions: repository().listExecutions(runId), run }
        : null;
    }),
  );

  app.post("/api/graph-runs/list", (c) =>
    handleGraphRequest(c, listRunsRequestSchema, ({ graphId, limit }) => ({
      runs: repository().listRuns(graphId, { limit }),
    })),
  );

  app.post("/api/graph-runs/active", (c) =>
    handleGraphRequest(c, activeRunRequestSchema, ({ projectId }) => ({
      run: repository().getActiveRunForProject(projectId),
    })),
  );

  app.post("/api/graph-runs/cancel", (c) =>
    handleGraphRequest(c, runIdRequestSchema, ({ runId }) => ({
      run: getGraphRunner().cancelRun(runId),
    })),
  );

  app.post("/api/graph-runs/resume", (c) =>
    handleGraphRequest(c, runIdRequestSchema, ({ runId }) => ({
      run: getGraphRunner().resumeRun(runId).run,
    })),
  );
};
