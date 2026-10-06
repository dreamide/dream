// The output stage behind the agent-turn writer: consecutive deltas of one
// part are joined, nothing is reordered, and nothing but a plain delta is
// touched.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createDeltaJoiner } from "./turn-output.js";

/** Runs `chunks` through a joiner with timers the test fires by hand. */
const run = async (chunks, { maxDelayMs = 50, fireTimersAfter = [] } = {}) => {
  const timers = [];
  const joiner = createDeltaJoiner({
    clearTimer: (handle) => {
      timers[handle] = null;
    },
    maxDelayMs,
    setTimer: (callback) => timers.push(callback) - 1,
  });
  const out = [];
  const reading = (async () => {
    const reader = joiner.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out.push(value);
    }
  })();
  const writer = joiner.writable.getWriter();
  for (const [index, chunk] of chunks.entries()) {
    await writer.write(chunk);
    if (fireTimersAfter.includes(index)) {
      for (const [handle, callback] of timers.entries()) {
        if (callback) {
          timers[handle] = null;
          callback();
        }
      }
    }
  }
  await writer.close();
  await reading;
  return out;
};

const text = (id, delta) => ({ delta, id, type: "text-delta" });

test("consecutive deltas of one part become one chunk", async () => {
  const out = await run([
    { id: "a", type: "text-start" },
    text("a", "Hel"),
    text("a", "lo"),
    text("a", " world"),
    { id: "a", type: "text-end" },
  ]);

  assert.deepEqual(out, [
    { id: "a", type: "text-start" },
    text("a", "Hello world"),
    { id: "a", type: "text-end" },
  ]);
});

test("any other chunk releases the held delta first, so order holds", async () => {
  const out = await run([
    text("a", "x"),
    { type: "reasoning-delta", id: "r", delta: "think" },
    { type: "reasoning-delta", id: "r", delta: "ing" },
    text("a", "y"),
    text("b", "z"),
    { toolCallId: "t", type: "tool-input-start", toolName: "Bash" },
  ]);

  assert.deepEqual(
    out.map((chunk) => [chunk.type, chunk.delta ?? chunk.toolCallId]),
    [
      ["text-delta", "x"],
      ["reasoning-delta", "thinking"],
      ["text-delta", "y"],
      ["text-delta", "z"],
      ["tool-input-start", "t"],
    ],
  );
});

test("a delta waits no longer than the delay", async () => {
  const out = await run([text("a", "1"), text("a", "2"), text("a", "3")], {
    fireTimersAfter: [1],
  });

  assert.deepEqual(
    out.map((chunk) => chunk.delta),
    ["12", "3"],
  );
});

test("with no delay, deltas wait for the next boundary however long", async () => {
  const out = await run(
    [text("a", "1"), text("a", "2"), { type: "finish-step" }, text("a", "3")],
    { fireTimersAfter: [0, 1], maxDelayMs: null },
  );

  assert.deepEqual(
    out.map((chunk) => chunk.delta ?? chunk.type),
    ["12", "finish-step", "3"],
  );
});

test("tool input deltas join by tool call", async () => {
  const out = await run([
    { inputTextDelta: '{"pa', toolCallId: "t", type: "tool-input-delta" },
    { inputTextDelta: 'th":1}', toolCallId: "t", type: "tool-input-delta" },
  ]);

  assert.deepEqual(out, [
    { inputTextDelta: '{"path":1}', toolCallId: "t", type: "tool-input-delta" },
  ]);
});

test("a delta carrying anything else passes through untouched", async () => {
  const withMetadata = {
    delta: "b",
    id: "a",
    providerMetadata: { x: 1 },
    type: "text-delta",
  };
  const out = await run([text("a", "a"), withMetadata, text("a", "c")]);

  assert.deepEqual(out, [text("a", "a"), withMetadata, text("a", "c")]);
});
