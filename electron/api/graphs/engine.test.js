import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
} from "../../persisted-state.js";
import { createGraphRunner } from "./engine.js";
import { createGraphRepository } from "./repository.js";

const PROJECT_ID = "project-1";

let directory;
let databasePath;
let repository;
let events;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dream-graph-test-"));
  databasePath = path.join(directory, "state.db");
  repository = createGraphRepository({ databasePath });
  const database = getPersistedStateDatabase({ databasePath });
  const timestamp = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO projects (id, path, normalized_path, name, status, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', 0, '{}', ?, ?)`,
    )
    .run(
      PROJECT_ID,
      "C:\\projects\\one",
      "c:/projects/one",
      "one",
      timestamp,
      timestamp,
    );
  events = [];
});

afterEach(async () => {
  closePersistedStateDatabase();
  await rm(directory, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resultText = (data, stateUpdates, summary = "done") =>
  `Work log...\n<workflow-result>\n${JSON.stringify({ data, stateUpdates, summary })}\n</workflow-result>`;

const cond = (field, value, operator = "eq") => ({ field, operator, value });

/**
 * Builds a graph. `spec.edges` entries: [source, target, condition?, priority?]
 */
const buildGraph = ({ nodes, edges, entry, maxIterations = 5 }) => {
  const graph = repository.createGraph({
    name: "fixture",
    projectId: PROJECT_ID,
  });
  return repository.saveGraphDefinition(graph.id, {
    edges: edges.map(
      ([source, target, condition = null, priority = 0], index) => ({
        condition,
        id: `e${index}-${source}-${target}`,
        priority,
        sourceNodeId: source,
        targetNodeId: target,
      }),
    ),
    entryNodeId: entry ?? nodes[0],
    nodes: nodes.map((name) =>
      typeof name === "string"
        ? { id: name, instructions: `do ${name}`, maxIterations, name }
        : name,
    ),
  });
};

/**
 * Scripted executor: `script[nodeId]` is an array of result strings (or
 * functions returning a promise of a string) consumed per call.
 */
const scriptedExecutor = (script) => {
  const calls = [];
  return {
    calls,
    execute: async ({ node, prompt, signal, repair }) => {
      calls.push({ nodeId: node.id, prompt, repair: Boolean(repair) });
      const queue = script[node.id] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) {
        throw new Error(`No scripted output for node ${node.id}`);
      }
      const value = typeof next === "function" ? await next({ signal }) : next;
      return { text: value };
    },
  };
};

const createRunner = (executor) =>
  createGraphRunner({
    emit: (event) => events.push(event),
    executor,
    getProjectPath: () => "C:\\projects\\one",
    repository,
  });

const executionTrail = (runId) =>
  repository
    .listExecutions(runId)
    .map((entry) => `${entry.nodeId}${entry.iteration}`);

// ---------------------------------------------------------------------------
// Tests (see plan §24)
// ---------------------------------------------------------------------------

test("linear graph executes A, B, C and completes", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B"],
      ["B", "C"],
    ],
  });
  const runner = createRunner(
    scriptedExecutor({
      A: [resultText({ status: "ok" }, { plan: "p" })],
      B: [resultText({ status: "ok" }, { impl: "i" })],
      C: [resultText({ status: "ok" })],
    }),
  );

  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  const finished = repository.getRun(run.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.currentNodeId, null);
  assert.deepEqual(finished.state, { impl: "i", plan: "p" });
  assert.deepEqual(executionTrail(run.id), ["A1", "B1", "C1"]);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "graph.run.started",
      "graph.node.started",
      "graph.node.completed",
      "graph.edge.traversed",
      "graph.node.started",
      "graph.node.completed",
      "graph.edge.traversed",
      "graph.node.started",
      "graph.node.completed",
      "graph.run.completed",
    ],
  );
  // Snapshot is stored on the run so later edits never affect it.
  assert.equal(finished.graphSnapshot.nodes.length, 3);
});

test("simple loop A → B → A runs two iterations then exits", async () => {
  const graph = buildGraph({
    nodes: ["A", "B"],
    edges: [
      ["A", "B"],
      ["B", "A", cond("again", true)],
    ],
  });
  const runner = createRunner(
    scriptedExecutor({
      A: [resultText({ status: "ok" })],
      B: [resultText({ again: true }), resultText({ again: false })],
    }),
  );

  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  assert.equal(repository.getRun(run.id).status, "completed");
  assert.deepEqual(executionTrail(run.id), ["A1", "B1", "A2", "B2"]);
  const traversals = events.filter(
    (event) => event.type === "graph.edge.traversed",
  );
  assert.deepEqual(
    traversals.map((event) => `${event.sourceNodeId}>${event.targetNodeId}`),
    ["A>B", "B>A", "A>B"],
  );
  // Graph itself is unchanged by the loop.
  assert.equal(repository.getGraph(graph.id).nodes.length, 2);
});

test("conditional routing chooses B or C based on data", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B", cond("route", "b")],
      ["A", "C", cond("route", "c")],
    ],
  });

  for (const route of ["b", "c"]) {
    events = [];
    const runner = createRunner(
      scriptedExecutor({
        A: [resultText({ route })],
        B: [resultText({})],
        C: [resultText({})],
      }),
    );
    const { run, promise } = runner.startRun({
      graphId: graph.id,
      projectId: PROJECT_ID,
    });
    await promise;
    assert.deepEqual(executionTrail(run.id), ["A1", `${route.toUpperCase()}1`]);
  }
});

test("fallback edge is followed when no condition matches", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B", cond("status", "failed")],
      ["A", "C"],
    ],
  });
  const runner = createRunner(
    scriptedExecutor({
      A: [resultText({ status: "passed" })],
      C: [resultText({})],
    }),
  );
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;
  assert.deepEqual(executionTrail(run.id), ["A1", "C1"]);
});

test("per-node iteration limit stops a self loop", async () => {
  const graph = buildGraph({
    nodes: ["A"],
    edges: [["A", "A"]],
    maxIterations: 3,
  });
  const runner = createRunner(scriptedExecutor({ A: [resultText({})] }));
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  const finished = repository.getRun(run.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error, /maximum of 3 iterations/);
  assert.deepEqual(executionTrail(run.id), ["A1", "A2", "A3"]);
  // Position is preserved so the run could be inspected/resumed.
  assert.equal(finished.currentNodeId, "A");
});

test("global execution limit stops a multi-node cycle", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B"],
      ["B", "C"],
      ["C", "A"],
    ],
    maxIterations: 100,
  });
  const runner = createRunner(
    scriptedExecutor({
      A: [resultText({})],
      B: [resultText({})],
      C: [resultText({})],
    }),
  );
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    maxExecutions: 7,
    projectId: PROJECT_ID,
  });
  await promise;

  const finished = repository.getRun(run.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error, /Maximum of 7 node executions/);
  assert.equal(repository.countExecutions(run.id), 7);
});

test("cancelling during B prevents C from executing", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B"],
      ["B", "C"],
    ],
  });
  let releaseB;
  const gate = new Promise((resolve) => {
    releaseB = resolve;
  });
  let bStarted;
  const bStartedPromise = new Promise((resolve) => {
    bStarted = resolve;
  });
  const executor = scriptedExecutor({
    A: [resultText({})],
    B: [
      async ({ signal }) => {
        bStarted();
        await gate;
        if (signal.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return resultText({});
      },
    ],
    C: [resultText({})],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });

  await bStartedPromise;
  const cancelled = runner.cancelRun(run.id);
  assert.equal(cancelled.status, "cancelled");
  releaseB();
  await promise;

  const finished = repository.getRun(run.id);
  assert.equal(finished.status, "cancelled");
  const executions = repository.listExecutions(run.id);
  assert.deepEqual(
    executions.map((entry) => `${entry.nodeId}:${entry.status}`),
    ["A:completed", "B:cancelled"],
  );
  assert.ok(!executor.calls.some((call) => call.nodeId === "C"));
  assert.ok(!runner.isActive(run.id));
});

test("a run can be resumed from its persisted currentNodeId", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B"],
      ["B", "C"],
    ],
  });

  // Simulate a run that completed A and crashed before B.
  const executor = scriptedExecutor({
    A: [resultText({}, { plan: "from A" })],
  });
  const failing = createGraphRunner({
    emit: () => {},
    executor: {
      execute: async (input) =>
        input.node.id === "A"
          ? executor.execute(input)
          : Promise.reject(new Error("crash")),
    },
    repository,
  });
  const { run, promise } = failing.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;
  let stored = repository.getRun(run.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.currentNodeId, "B");
  assert.deepEqual(stored.state, { plan: "from A" });

  // Reconstruct from stored state only and continue.
  const resumedExecutor = scriptedExecutor({
    B: [resultText({}, { impl: "from B" })],
    C: [resultText({})],
  });
  const runner = createRunner(resumedExecutor);
  const resumed = runner.resumeRun(run.id);
  await resumed.promise;

  stored = repository.getRun(run.id);
  assert.equal(stored.status, "completed");
  assert.deepEqual(stored.state, { impl: "from B", plan: "from A" });
  assert.deepEqual(
    repository
      .listExecutions(run.id)
      .map((entry) => `${entry.nodeId}:${entry.status}`),
    ["A:completed", "B:failed", "B:completed", "C:completed"],
  );
  // The resumed B prompt still saw A's result.
  assert.match(resumedExecutor.calls[0].prompt, /Result of the previous step/);
  assert.match(resumedExecutor.calls[0].prompt, /Step "A"/);
});

test("malformed results get repair turns, then fail the run", async () => {
  const graph = buildGraph({ nodes: ["A", "B"], edges: [["A", "B"]] });
  const executor = scriptedExecutor({
    A: ["I forgot the block", resultText({ status: "fixed" })],
    B: ["nope", "still nope"],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  const executions = repository.listExecutions(run.id);
  assert.equal(executions[0].status, "completed");
  assert.equal(executions[0].result.data.status, "fixed");
  assert.match(executions[0].outputText, /\[repair turn\]/);
  assert.equal(executions[1].status, "failed");
  assert.match(executions[1].error, /Malformed workflow result/);
  assert.equal(repository.getRun(run.id).status, "failed");
  assert.deepEqual(
    executor.calls.map((call) => `${call.nodeId}${call.repair ? "*" : ""}`),
    ["A", "A*", "B", "B*", "B*"],
  );
});

test("executor failures mark the execution and run failed without retry", async () => {
  const graph = buildGraph({ nodes: ["A", "B"], edges: [["A", "B"]] });
  let calls = 0;
  const runner = createRunner({
    execute: async () => {
      calls += 1;
      throw new Error("provider exploded");
    },
  });
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;
  assert.equal(calls, 1);
  const finished = repository.getRun(run.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.error, "provider exploded");
  assert.equal(repository.listExecutions(run.id)[0].error, "provider exploded");
  assert.equal(events.at(-1).type, "graph.run.failed");
});

test("startRun rejects invalid graphs and concurrent runs per project", async () => {
  const invalid = repository.createGraph({
    name: "empty",
    projectId: PROJECT_ID,
  });
  const runner = createRunner(scriptedExecutor({}));
  assert.throws(
    () => runner.startRun({ graphId: invalid.id, projectId: PROJECT_ID }),
    /no nodes/i,
  );

  const graph = buildGraph({ nodes: ["A"], edges: [] });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const blocking = createRunner({
    execute: async () => {
      await gate;
      return { text: resultText({}) };
    },
  });
  const first = blocking.startRun({ graphId: graph.id, projectId: PROJECT_ID });
  assert.throws(
    () => blocking.startRun({ graphId: graph.id, projectId: PROJECT_ID }),
    /already active/,
  );
  release();
  await first.promise;
  assert.equal(repository.getRun(first.run.id).status, "completed");
});

test("recoverInterruptedRuns marks orphaned running runs as failed", async () => {
  const graph = buildGraph({ nodes: ["A", "B"], edges: [["A", "B"]] });
  const run = repository.createRun({
    graphId: graph.id,
    graphSnapshot: { entryNodeId: "A", edges: [], nodes: [] },
    projectId: PROJECT_ID,
  });
  repository.updateRun(run.id, { currentNodeId: "B", status: "running" });
  repository.createExecution({
    input: {},
    iteration: 1,
    nodeId: "B",
    runId: run.id,
    sequence: 1,
  });

  const runner = createRunner(scriptedExecutor({}));
  assert.equal(runner.recoverInterruptedRuns(), 1);
  const recovered = repository.getRun(run.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.currentNodeId, "B");
  assert.equal(repository.listExecutions(run.id)[0].status, "failed");
});

test("plan → implement → test → review fixture loops and completes", async () => {
  const graph = buildGraph({
    nodes: ["plan", "implement", "test", "review"],
    edges: [
      ["plan", "implement"],
      ["implement", "test"],
      ["test", "implement", cond("status", "failed"), 0],
      ["test", "plan", cond("failureType", "architecture"), -1],
      ["test", "review"],
      ["review", "implement", cond("status", "changes")],
    ],
  });
  const runner = createRunner(
    scriptedExecutor({
      plan: [resultText({ status: "ok" }, { plan: "v1" })],
      implement: [resultText({ status: "ok" })],
      test: [
        resultText({ status: "failed", failureType: "implementation" }),
        resultText({ status: "passed" }),
        resultText({ status: "passed" }),
      ],
      review: [
        resultText({ status: "changes" }),
        resultText({ status: "approved" }),
      ],
    }),
  );
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  assert.equal(repository.getRun(run.id).status, "completed");
  assert.deepEqual(
    repository.listExecutions(run.id).map((entry) => entry.nodeId),
    [
      "plan",
      "implement",
      "test",
      "implement",
      "test",
      "review",
      "implement",
      "test",
      "review",
    ],
  );
  assert.deepEqual(executionTrail(run.id).slice(-3), [
    "implement3",
    "test3",
    "review2",
  ]);
});

// ---------------------------------------------------------------------------
// Declared outputs
// ---------------------------------------------------------------------------

const testNode = {
  id: "T",
  instructions: "run the tests",
  maxIterations: 5,
  name: "Test",
  outputs: [
    { key: "status", options: ["passed", "failed"], type: "enum" },
    { key: "details", saveToState: true, type: "text" },
  ],
};

test("declared outputs generate the contract, normalize values and share state", async () => {
  const graph = buildGraph({
    edges: [
      ["T", "Fix", cond("status", "failed")],
      ["T", "Done"],
    ],
    nodes: [testNode, "Fix", "Done"],
  });
  const executor = scriptedExecutor({
    Done: [resultText({})],
    Fix: [resultText({})],
    T: [resultText({ Status: " FAILED ", details: "2 specs red" })],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    initialState: { task: "Ship pagination" },
    projectId: PROJECT_ID,
  });
  await promise;

  const [first, second] = repository.listExecutions(run.id);
  assert.match(
    first.input.prompt,
    /Task for this workflow run\nShip pagination/,
  );
  assert.match(first.input.prompt, /"status": "passed" \| "failed"/);
  assert.match(first.input.prompt, /`status` \(required\): exactly one of/);
  assert.deepEqual(first.result.data, {
    details: "2 specs red",
    status: "failed",
  });
  assert.equal(second.nodeId, "Fix");
  assert.deepEqual(repository.getRun(run.id).state.steps, {
    Test: { details: "2 specs red" },
  });
});

test("values outside the declared options get a targeted repair turn", async () => {
  const graph = buildGraph({ edges: [], nodes: [testNode] });
  const executor = scriptedExecutor({
    T: [
      resultText({ details: "ok", status: "success" }),
      resultText({ details: "ok", status: "passed" }),
    ],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  assert.equal(repository.getRun(run.id).status, "completed");
  assert.match(executor.calls[1].prompt, /must be one of "passed", "failed"/);
  assert.equal(
    repository.listExecutions(run.id)[0].result.data.status,
    "passed",
  );
});

test("a run fails instead of completing when the routing field was never returned", async () => {
  const graph = buildGraph({
    edges: [["A", "B", cond("status", "failed")]],
    nodes: ["A", "B"],
  });
  const runner = createRunner(
    scriptedExecutor({ A: [resultText({ outcome: "failed" })] }),
  );
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  const finished = repository.getRun(run.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error, /did not return "status"/);
});

test("validation rejects conditions that do not match declared outputs", () => {
  const graph = buildGraph({
    edges: [
      ["T", "A", cond("state", "failed")],
      ["T", "B", cond("status", "broken"), 1],
    ],
    nodes: [testNode, "A", "B"],
  });
  const runner = createRunner(scriptedExecutor({}));
  assert.throws(
    () => runner.startRun({ graphId: graph.id, projectId: PROJECT_ID }),
    (error) => {
      assert.deepEqual(error.errors.map((entry) => entry.code).sort(), [
        "condition_unknown_field",
        "condition_unknown_value",
      ]);
      return true;
    },
  );
});

test("run inputs are validated, coerced and usable as placeholders", async () => {
  const created = buildGraph({
    edges: [["Plan", "Build"]],
    nodes: [
      {
        id: "Plan",
        instructions: "Plan {{task}} on {{input.branch}}",
        maxIterations: 5,
        name: "Plan",
        outputs: [{ key: "plan", saveToState: true, type: "text" }],
      },
      {
        id: "Build",
        instructions: "Follow this plan: {{Plan.plan}} ({{Plan.nope}})",
        maxIterations: 5,
        name: "Build",
      },
    ],
  });
  const graph = repository.saveGraphDefinition(created.id, {
    edges: created.edges,
    entryNodeId: created.entryNodeId,
    inputs: [
      { key: "branch", label: "Branch", type: "text" },
      { key: "retries", required: false, type: "number" },
    ],
    nodes: created.nodes,
  });
  const executor = scriptedExecutor({
    Build: [resultText({})],
    Plan: [`Sure. {"summary": "planned", "data": {"plan": "use cursors",},}`],
  });
  const runner = createRunner(executor);

  assert.throws(
    () => runner.startRun({ graphId: graph.id, projectId: PROJECT_ID }),
    /Run input "Branch" is required/,
  );

  const { run, promise } = runner.startRun({
    graphId: graph.id,
    initialState: { inputs: { branch: "main", retries: "3" }, task: "paging" },
    projectId: PROJECT_ID,
  });
  await promise;

  assert.deepEqual(repository.getRun(run.id).state.inputs, {
    branch: "main",
    retries: 3,
  });
  assert.match(executor.calls[0].prompt, /Plan paging on main/);
  assert.match(executor.calls[0].prompt, /## Run inputs\n- Branch: main/);
  // Bare JSON with trailing commas is salvaged without a repair turn.
  assert.equal(executor.calls.length, 2);
  assert.match(
    executor.calls[1].prompt,
    /Follow this plan: use cursors \(\(not available yet\)\)/,
  );
});
