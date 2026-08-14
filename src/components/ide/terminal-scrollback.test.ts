import assert from "node:assert/strict";
import { test } from "vitest";
import {
  deleteTerminalScrollback,
  getTerminalScrollback,
  hasTerminalScrollback,
  publishTerminalOutput,
  resetTerminalScrollback,
  subscribeToTerminalOutput,
} from "./terminal-scrollback";

test("publishes terminal output to the session buffer and live listeners", () => {
  const sessionId = "terminal-live";
  const receivedChunks: string[] = [];
  resetTerminalScrollback(sessionId);
  const unsubscribe = subscribeToTerminalOutput(sessionId, (chunk) => {
    receivedChunks.push(chunk);
  });

  assert.equal(publishTerminalOutput(sessionId, "one"), true);
  assert.equal(publishTerminalOutput(sessionId, "two"), true);
  assert.equal(getTerminalScrollback(sessionId), "onetwo");
  assert.deepEqual(receivedChunks, ["one", "two"]);

  unsubscribe();
  deleteTerminalScrollback(sessionId);
});

test("bounds scrollback without concatenating the full buffer per chunk", () => {
  const sessionId = "terminal-bounded";
  resetTerminalScrollback(sessionId);

  publishTerminalOutput(sessionId, "a".repeat(100_000));
  publishTerminalOutput(sessionId, "b".repeat(100_000));

  const scrollback = getTerminalScrollback(sessionId);
  assert.equal(scrollback.length, 150_000);
  assert.equal(scrollback, `${"a".repeat(50_000)}${"b".repeat(100_000)}`);

  deleteTerminalScrollback(sessionId);
});

test("ignores unknown sessions and deletes closed session state", () => {
  const sessionId = "terminal-closed";
  assert.equal(publishTerminalOutput(sessionId, "ignored"), false);

  resetTerminalScrollback(sessionId);
  assert.equal(hasTerminalScrollback(sessionId), true);
  publishTerminalOutput(sessionId, "saved");
  deleteTerminalScrollback(sessionId);

  assert.equal(hasTerminalScrollback(sessionId), false);
  assert.equal(getTerminalScrollback(sessionId), "");
});
