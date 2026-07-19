import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectDescendantProcessIds,
  parsePosixProcessTable,
} from "./process-tree.js";

test("parses a POSIX process table", () => {
  assert.deepEqual(
    parsePosixProcessTable(`
      100     1
      101   100
      invalid row
      102   101
    `),
    [
      { parentProcessId: 1, processId: 100 },
      { parentProcessId: 100, processId: 101 },
      { parentProcessId: 101, processId: 102 },
    ],
  );
});

test("collects descendants deepest-first without unrelated processes", () => {
  const processTable = [
    { parentProcessId: 1, processId: 100 },
    { parentProcessId: 100, processId: 101 },
    { parentProcessId: 100, processId: 102 },
    { parentProcessId: 101, processId: 103 },
    { parentProcessId: 50, processId: 200 },
  ];

  assert.deepEqual(
    collectDescendantProcessIds(100, processTable),
    [103, 101, 102],
  );
});

test("does not loop on malformed cyclic process data", () => {
  const processTable = [
    { parentProcessId: 100, processId: 101 },
    { parentProcessId: 101, processId: 100 },
  ];

  assert.deepEqual(collectDescendantProcessIds(100, processTable), [101]);
});
