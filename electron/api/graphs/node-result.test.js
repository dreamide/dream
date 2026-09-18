import assert from "node:assert/strict";
import { test } from "vitest";
import { extractNodeResult } from "./node-result.js";
import { validateGraph } from "./validation.js";

test("extractNodeResult accepts tagged, fenced and bare results", () => {
  const tagged = extractNodeResult(
    'log\n<workflow-result>{"status":"success","message":"ok"}</workflow-result>',
  );
  assert.deepEqual(tagged.result, {
    data: { status: "success" },
    message: "ok",
    status: "success",
    summary: "ok",
  });

  const fenced = extractNodeResult(
    'done\n```json\n{"status":"Failed","message":"red"}\n```',
  );
  assert.equal(fenced.result.status, "failure");

  // Results written by earlier versions: { data: { status }, summary }.
  const legacy = extractNodeResult(
    '<workflow-result>{"data":{"status":"passed"},"summary":"fine"}</workflow-result>',
  );
  assert.equal(legacy.result.status, "success");
  assert.equal(legacy.result.message, "fine");

  // The last block wins.
  const last = extractNodeResult(
    '<workflow-result>{"status":"failure"}</workflow-result> retry <workflow-result>{"status":"success"}</workflow-result>',
  );
  assert.equal(last.result.status, "success");

  assert.equal(extractNodeResult("no block here").ok, false);
  assert.match(
    extractNodeResult('{"message":"x"}').error,
    /"status" is missing/,
  );
});

test("validateGraph reports structural errors but not cycles", () => {
  const node = (id) => ({ id, maxIterations: 5, name: id });
  const edge = (id, source, target, outcome = "success") => ({
    id,
    outcome,
    sourceNodeId: source,
    targetNodeId: target,
  });

  assert.equal(
    validateGraph({ edges: [], entryNodeId: null, nodes: [] }).errors[0].code,
    "no_nodes",
  );

  const result = validateGraph({
    edges: [
      edge("e1", "A", "B"),
      edge("e2", "B", "A", "failure"),
      edge("e3", "A", "C"),
      edge("e4", "A", "ghost", "failure"),
    ],
    entryNodeId: "A",
    nodes: [node("A"), node("B"), node("C"), node("D")],
  });
  assert.deepEqual(result.errors.map((entry) => entry.code).sort(), [
    "dangling_edge",
    "duplicate_outcome",
  ]);
  assert.deepEqual(
    result.warnings.map((entry) => entry.code),
    ["unreachable"],
  );
});
