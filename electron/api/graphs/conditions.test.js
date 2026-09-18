import assert from "node:assert/strict";
import { test } from "vitest";
import {
  evaluateCondition,
  getFieldValue,
  resolveNextEdge,
  sortEdgesForEvaluation,
} from "./conditions.js";
import { extractNodeResult, mergeRunState } from "./node-result.js";
import { validateGraph } from "./validation.js";

const edge = (
  id,
  sourceNodeId,
  targetNodeId,
  condition = null,
  priority = 0,
) => ({
  condition,
  id,
  priority,
  sourceNodeId,
  targetNodeId,
});

test("getFieldValue resolves dotted paths and array indexes", () => {
  const data = { tests: { status: "failed", failing: ["a", "b"] } };
  assert.equal(getFieldValue(data, "tests.status"), "failed");
  assert.equal(getFieldValue(data, "tests.failing.1"), "b");
  assert.equal(getFieldValue(data, "tests.missing.deep"), undefined);
  assert.equal(getFieldValue(data, ""), undefined);
});

test("evaluateCondition covers every operator with strict equality", () => {
  const data = { status: "failed", count: 3, tags: ["x", "y"], nil: null };
  assert.ok(
    evaluateCondition(
      { field: "status", operator: "eq", value: "failed" },
      data,
    ),
  );
  assert.ok(
    !evaluateCondition({ field: "count", operator: "eq", value: "3" }, data),
  );
  assert.ok(
    evaluateCondition(
      { field: "status", operator: "neq", value: "passed" },
      data,
    ),
  );
  assert.ok(evaluateCondition({ field: "status", operator: "exists" }, data));
  assert.ok(!evaluateCondition({ field: "nil", operator: "exists" }, data));
  assert.ok(
    evaluateCondition({ field: "missing", operator: "not_exists" }, data),
  );
  assert.ok(
    evaluateCondition(
      { field: "status", operator: "contains", value: "fail" },
      data,
    ),
  );
  assert.ok(
    evaluateCondition(
      { field: "tags", operator: "contains", value: "y" },
      data,
    ),
  );
  assert.ok(
    !evaluateCondition(
      { field: "count", operator: "contains", value: 3 },
      data,
    ),
  );
  assert.ok(!evaluateCondition({ field: "status", operator: "bogus" }, data));
  assert.ok(evaluateCondition(null, data));
});

test("sortEdgesForEvaluation orders by priority, id, then fallback last", () => {
  const edges = [
    edge("z", "a", "b", null, -10),
    edge("b", "a", "c", { field: "s", operator: "eq", value: 1 }, 2),
    edge("a", "a", "d", { field: "s", operator: "eq", value: 1 }, 2),
    edge("c", "a", "e", { field: "s", operator: "eq", value: 1 }, 1),
  ];
  assert.deepEqual(
    sortEdgesForEvaluation(edges).map((entry) => entry.id),
    ["c", "a", "b", "z"],
  );
});

test("resolveNextEdge picks the first matching edge or the fallback", () => {
  const edges = [
    edge("fallback", "test", "review"),
    edge(
      "fail",
      "test",
      "implement",
      { field: "status", operator: "eq", value: "failed" },
      0,
    ),
    edge(
      "arch",
      "test",
      "plan",
      { field: "failureType", operator: "eq", value: "architecture" },
      -1,
    ),
  ];
  assert.equal(
    resolveNextEdge({
      data: { status: "failed", failureType: "architecture" },
      edges,
      nodeId: "test",
    }).id,
    "arch",
  );
  assert.equal(
    resolveNextEdge({ data: { status: "failed" }, edges, nodeId: "test" }).id,
    "fail",
  );
  assert.equal(
    resolveNextEdge({ data: { status: "passed" }, edges, nodeId: "test" }).id,
    "fallback",
  );
  assert.equal(resolveNextEdge({ data: {}, edges, nodeId: "other" }), null);
});

test("extractNodeResult parses tagged, fenced and bare JSON, and validates", () => {
  const tagged = extractNodeResult(
    'I did things.\n<workflow-result>\n{"summary":"ok","data":{"status":"passed"},"stateUpdates":{"tests":{"status":"passed"}}}\n</workflow-result>',
  );
  assert.ok(tagged.ok);
  assert.equal(tagged.result.data.status, "passed");
  assert.deepEqual(tagged.result.stateUpdates, { tests: { status: "passed" } });

  const fenced = extractNodeResult(
    'text\n```json\n{"summary":"s","data":{"a":1}}\n```',
  );
  assert.ok(fenced.ok);
  assert.equal(fenced.result.data.a, 1);

  const bare = extractNodeResult('{"data":{"x":true}}');
  assert.ok(bare.ok);
  assert.equal(bare.result.summary, "");

  const missing = extractNodeResult("no json here");
  assert.ok(!missing.ok);
  assert.match(missing.error, /workflow-result/);

  const invalid = extractNodeResult(
    '<workflow-result>{"summary":5,"data":[]}</workflow-result>',
  );
  assert.ok(!invalid.ok);
  assert.match(invalid.error, /schema/);

  // The last block wins when the agent quotes an example earlier.
  const last = extractNodeResult(
    '<workflow-result>{"data":{"status":"example"}}</workflow-result> ... <workflow-result>{"data":{"status":"real"}}</workflow-result>',
  );
  assert.equal(last.result.data.status, "real");
});

test("mergeRunState is a shallow top-level merge", () => {
  const merged = mergeRunState({ a: { x: 1 }, b: 2 }, { a: { y: 2 }, c: 3 });
  assert.deepEqual(merged, { a: { y: 2 }, b: 2, c: 3 });
  assert.deepEqual(mergeRunState({ a: 1 }, undefined), { a: 1 });
});

test("validateGraph reports errors and warnings but not cycles", () => {
  const nodes = [
    { id: "a", maxIterations: 5, name: "A" },
    { id: "b", maxIterations: 5, name: "B" },
    { id: "orphan", maxIterations: 0, name: "" },
  ];
  const edges = [
    edge("ab", "a", "b"),
    edge("ba", "b", "a", { field: "again", operator: "eq", value: true }),
    edge("bb", "b", "a", { field: "x", operator: "nope" }),
    edge("dangling", "a", "ghost"),
    edge("ab2", "a", "b"),
  ];
  const { errors, warnings } = validateGraph({
    edges,
    entryNodeId: "a",
    nodes,
  });
  const codes = errors.map((entry) => entry.code);
  assert.ok(codes.includes("node_name"));
  assert.ok(codes.includes("max_iterations"));
  assert.ok(codes.includes("condition_operator"));
  assert.ok(codes.includes("dangling_edge"));
  assert.ok(codes.includes("multiple_fallbacks"));
  assert.ok(!codes.some((code) => /cycle/.test(code)));

  const warningCodes = warnings.map((entry) => entry.code);
  assert.ok(warningCodes.includes("unreachable"));
  assert.ok(warningCodes.includes("no_fallback"));

  const clean = validateGraph({
    edges: [edge("ab", "a", "b"), edge("ba", "b", "a")],
    entryNodeId: "a",
    nodes: nodes.slice(0, 2),
  });
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.warnings, []);

  assert.equal(
    validateGraph({ edges: [], entryNodeId: "zzz", nodes: nodes.slice(0, 1) })
      .errors[0].code,
    "missing_entry",
  );
  assert.equal(
    validateGraph({ edges: [], entryNodeId: null, nodes: [] }).errors[0].code,
    "no_nodes",
  );
});
