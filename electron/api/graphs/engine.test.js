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

const resultText = (status = "success", message = "done") =>
  `Work log...\n<workflow-result>\n${JSON.stringify({ message, status })}\n</workflow-result>`;

/**
 * Builds a graph. `spec.edges` entries: [source, target, outcome = "success"]
 */
const buildGraph = ({ nodes, edges, entry, maxIterations = 5 }) => {
  const graph = repository.createGraph({
    name: "fixture",
    projectId: PROJECT_ID,
  });
  return repository.saveGraphDefinition(graph.id, {
    edges: edges.map(([source, target, outcome = "success"], index) => ({
      id: `e${index}-${source}-${target}`,
      outcome,
      sourceNodeId: source,
      targetNodeId: target,
    })),
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
      A: [resultText("success", "planned")],
      B: [resultText("ok", "built")],
      C: [resultText("passed")],
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
  assert.deepEqual(finished.state.steps, {
    A: { message: "planned", status: "success" },
    B: { message: "built", status: "success" },
    C: { message: "done", status: "success" },
  });
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
      ["B", "A", "failure"],
    ],
  });
  const runner = createRunner(
    scriptedExecutor({
      A: [resultText()],
      B: [resultText("failure", "try again"), resultText()],
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

test("routing follows the success or failure edge", async () => {
  const graph = buildGraph({
    nodes: ["A", "B", "C"],
    edges: [
      ["A", "B", "success"],
      ["A", "C", "failure"],
    ],
  });

  for (const [status, route] of [
    ["success", "b"],
    ["FAILED", "c"],
  ]) {
    events = [];
    const runner = createRunner(
      scriptedExecutor({
        A: [resultText(status)],
        B: [resultText()],
        C: [resultText()],
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

test("an unconnected outcome ends the run: success completes, failure fails", async () => {
  const graph = buildGraph({ nodes: ["A", "B"], edges: [["A", "B"]] });

  const failing = createRunner(
    scriptedExecutor({ A: [resultText("failure", "2 specs are red")] }),
  );
  const failed = failing.startRun({ graphId: graph.id, projectId: PROJECT_ID });
  await failed.promise;
  const failedRun = repository.getRun(failed.run.id);
  assert.equal(failedRun.status, "failed");
  assert.match(failedRun.error, /Step "A" failed: 2 specs are red/);
  assert.deepEqual(executionTrail(failed.run.id), ["A1"]);

  const passing = createRunner(
    scriptedExecutor({ A: [resultText()], B: [resultText()] }),
  );
  const passed = passing.startRun({ graphId: graph.id, projectId: PROJECT_ID });
  await passed.promise;
  assert.equal(repository.getRun(passed.run.id).status, "completed");
  assert.deepEqual(executionTrail(passed.run.id), ["A1", "B1"]);
});

test("per-node iteration limit stops a self loop", async () => {
  const graph = buildGraph({
    nodes: ["A"],
    edges: [["A", "A"]],
    maxIterations: 3,
  });
  const runner = createRunner(scriptedExecutor({ A: [resultText()] }));
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
      A: [resultText()],
      B: [resultText()],
      C: [resultText()],
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
    A: [resultText()],
    B: [
      async ({ signal }) => {
        bStarted();
        await gate;
        if (signal.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return resultText();
      },
    ],
    C: [resultText()],
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
    A: [resultText("success", "from A")],
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
  assert.deepEqual(stored.state.steps, {
    A: { message: "from A", status: "success" },
  });

  // Reconstruct from stored state only and continue.
  const resumedExecutor = scriptedExecutor({
    B: [resultText("success", "from B")],
    C: [resultText()],
  });
  const runner = createRunner(resumedExecutor);
  const resumed = runner.resumeRun(run.id);
  await resumed.promise;

  stored = repository.getRun(run.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.state.steps.B.message, "from B");
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
    A: ["I forgot the block", resultText("success", "fixed")],
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
  assert.equal(executions[0].result.message, "fixed");
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
      return { text: resultText() };
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
      ["test", "implement", "failure"],
      ["test", "review"],
      ["review", "implement", "failure"],
    ],
  });
  const runner = createRunner(
    scriptedExecutor({
      plan: [resultText("success", "plan v1")],
      implement: [resultText()],
      test: [
        resultText("failed", "users.test.ts is red"),
        resultText("passed"),
        resultText("passed"),
      ],
      review: [
        resultText("changes", "rename the hook"),
        resultText("approved"),
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

test("steps see the task and what earlier steps reported", async () => {
  const graph = buildGraph({
    nodes: ["Plan", "Build", "Check"],
    edges: [
      ["Plan", "Build"],
      ["Build", "Check"],
    ],
  });
  const executor = scriptedExecutor({
    Build: [resultText("success", "added the endpoint")],
    // Bare JSON with a trailing comma and a status synonym still parses.
    Check: ['All good. {"status": "Passed", "message": "42 tests green",}'],
    Plan: [resultText("success", "use cursors")],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    initialState: { task: "Ship pagination" },
    projectId: PROJECT_ID,
  });
  await promise;

  assert.equal(repository.getRun(run.id).status, "completed");
  assert.equal(executor.calls.length, 3);
  const checkPrompt = executor.calls[2].prompt;
  assert.match(checkPrompt, /Task for this workflow run\nShip pagination/);
  assert.match(checkPrompt, /- Plan \(success\): use cursors/);
  assert.match(checkPrompt, /Step "Build": success\nadded the endpoint/);
  assert.match(checkPrompt, /"status": "success" \| "failure"/);
  assert.equal(
    repository.listExecutions(run.id)[2].result.message,
    "42 tests green",
  );
});

test("an unrecognizable status gets a repair turn naming the problem", async () => {
  const graph = buildGraph({ nodes: ["A"], edges: [] });
  const executor = scriptedExecutor({
    A: [resultText("maybe"), resultText("success")],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  assert.equal(repository.getRun(run.id).status, "completed");
  assert.match(
    executor.calls[1].prompt,
    /"status" must be "success" or "failure" \(received "maybe"\)/,
  );
});

test("graphs saved with conditions load as success/failure edges", () => {
  const created = buildGraph({
    nodes: ["Test", "Plan", "Fix", "Review"],
    edges: [],
  });
  const database = getPersistedStateDatabase({ databasePath });
  const insert = database.prepare(
    `INSERT INTO agent_graph_edges (id, graph_id, source_node_id, target_node_id, condition, priority)
     VALUES (?, ?, 'Test', ?, ?, ?)`,
  );
  insert.run(
    "arch",
    created.id,
    "Plan",
    JSON.stringify({
      field: "failureType",
      operator: "eq",
      value: "architecture",
    }),
    0,
  );
  insert.run(
    "failed",
    created.id,
    "Fix",
    JSON.stringify({ field: "status", operator: "eq", value: "failed" }),
    1,
  );
  insert.run("fallback", created.id, "Review", null, 0);

  const edges = repository.getGraph(created.id).edges;
  assert.deepEqual(edges.map((edge) => `${edge.id}:${edge.outcome}`).sort(), [
    "failed:failure",
    "fallback:success",
  ]);
});

test("task steps always continue and need no status", async () => {
  const graph = buildGraph({
    nodes: [
      {
        id: "Plan",
        instructions: "plan it",
        maxIterations: 5,
        name: "Plan",
        type: "task",
      },
      "Check",
    ],
    edges: [["Plan", "Check"]],
  });
  assert.equal(repository.getGraph(graph.id).nodes[0].type, "task");
  assert.equal(repository.getGraph(graph.id).nodes[1].type, "decision");

  const executor = scriptedExecutor({
    Check: [resultText()],
    // No result block at all: the response itself becomes the message.
    Plan: ["1. add the endpoint\n2. test it"],
  });
  const runner = createRunner(executor);
  const { run, promise } = runner.startRun({
    graphId: graph.id,
    projectId: PROJECT_ID,
  });
  await promise;

  assert.equal(repository.getRun(run.id).status, "completed");
  assert.deepEqual(
    executor.calls.map((call) => `${call.nodeId}${call.repair ? "*" : ""}`),
    ["Plan", "Check"],
  );
  assert.doesNotMatch(executor.calls[0].prompt, /"status"/);
  assert.match(executor.calls[1].prompt, /1\. add the endpoint/);
});

test("a task cannot have a failure connection", () => {
  const graph = buildGraph({
    nodes: [
      {
        id: "Plan",
        instructions: "",
        maxIterations: 5,
        name: "Plan",
        type: "task",
      },
      "B",
    ],
    edges: [["Plan", "B", "failure"]],
  });
  const runner = createRunner(scriptedExecutor({}));
  assert.throws(
    () => runner.startRun({ graphId: graph.id, projectId: PROJECT_ID }),
    /is a task and cannot fail/,
  );
});
