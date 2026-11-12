import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { followTurnMessage } from "./turn-message.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A chunk stream the test writes to as the turn goes on. */
const chunkStream = () => {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    write: (...chunks) => {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
};

const textOf = (message) =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

const follow = (stream, options = {}) => {
  const reports = [];
  const done = followTurnMessage(stream, {
    intervalMs: 1000,
    report: (message, { final }) => {
      reports.push({ final, message });
    },
    ...options,
  });
  return { done, reports };
};

const tool = (id, output) => [
  {
    dynamic: true,
    providerExecuted: true,
    toolCallId: id,
    toolName: "Bash",
    type: "tool-input-start",
  },
  {
    dynamic: true,
    input: { command: id },
    providerExecuted: true,
    toolCallId: id,
    toolName: "Bash",
    type: "tool-input-available",
  },
  {
    dynamic: true,
    output,
    providerExecuted: true,
    toolCallId: id,
    type: "tool-output-available",
  },
];

test("a turn is reported once per interval while it changes, and at its end", async () => {
  vi.useFakeTimers();
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream);

  turn.write(
    { messageId: "a1", type: "start" },
    { id: "t", type: "text-start" },
    { delta: "One.", id: "t", type: "text-delta" },
  );
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(reports.length, 0, "nothing before the first interval");
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(reports.length, 1);
  assert.equal(textOf(reports[0].message), "One.");
  assert.equal(reports[0].final, false);

  // Nothing changed: no report.
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(reports.length, 1);

  // After a quiet interval the next change is due at once...
  turn.write({ delta: " Two.", id: "t", type: "text-delta" });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(reports.length, 2);
  assert.equal(textOf(reports[1].message), "One. Two.");

  // ...and the changes in the interval after it make one report.
  for (const delta of [" Three.", " Four."]) {
    turn.write({ delta, id: "t", type: "text-delta" });
    await vi.advanceTimersByTimeAsync(10);
  }
  assert.equal(reports.length, 2);
  await vi.advanceTimersByTimeAsync(980);
  assert.equal(reports.length, 3);
  assert.equal(textOf(reports[2].message), "One. Two. Three. Four.");

  turn.write({ delta: " Five.", id: "t", type: "text-delta" });
  turn.write({ id: "t", type: "text-end" }, { type: "finish" });
  turn.close();
  await done;
  assert.equal(reports.length, 4);
  assert.equal(reports[3].final, true);
  assert.equal(reports[3].message.id, "a1");
  assert.equal(textOf(reports[3].message), "One. Two. Three. Four. Five.");
  assert.equal(vi.getTimerCount(), 0);
});

test("a turn shorter than the interval is reported once, at its end", async () => {
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream);
  turn.write(
    { type: "start" },
    { id: "t", type: "text-start" },
    { delta: "Quick.", id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
  );
  turn.close();
  await done;
  assert.deepEqual(
    reports.map(({ final, message }) => [final, textOf(message)]),
    [[true, "Quick."]],
  );
});

test("a report is never made while the one before it is still being handled", async () => {
  vi.useFakeTimers();
  const turn = chunkStream();
  let release;
  let active = 0;
  let overlapped = false;
  const reports = [];
  const done = followTurnMessage(turn.stream, {
    intervalMs: 100,
    report: async (message, { final }) => {
      active += 1;
      overlapped ||= active > 1;
      reports.push({ final, text: textOf(message) });
      if (!final) await new Promise((resolve) => (release = resolve));
      active -= 1;
    },
  });

  turn.write(
    { type: "start" },
    { id: "t", type: "text-start" },
    { delta: "a", id: "t", type: "text-delta" },
  );
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(reports.length, 1);
  // The save is slow: changes meanwhile wait for it.
  turn.write({ delta: "b", id: "t", type: "text-delta" });
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(reports.length, 1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(reports.length, 2);
  assert.equal(reports[1].text, "ab");

  // The end waits for a report under way, and comes after it.
  turn.write({ delta: "c", id: "t", type: "text-delta" });
  turn.close();
  await vi.advanceTimersByTimeAsync(0);
  release();
  await done;
  assert.equal(overlapped, false);
  assert.deepEqual(reports.at(-1), { final: true, text: "abc" });
});

test("each report is the caller's own copy, taken when it is made", async () => {
  vi.useFakeTimers();
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream);
  turn.write({ type: "start" }, ...tool("t1", { stdout: "x".repeat(50_000) }));
  await vi.advanceTimersByTimeAsync(1000);
  const first = reports[0].message;
  assert.equal(first.parts.length, 1);

  turn.write(...tool("t2", { stdout: "two" }));
  first.parts[0].output.stdout = "changed by the caller";
  turn.close();
  await done;
  const final = reports.at(-1).message;
  assert.equal(first.parts.length, 1, "later chunks do not reach a report");
  assert.equal(final.parts.length, 2);
  assert.equal(final.parts[0].output.stdout, "x".repeat(50_000));
  assert.equal(final.parts[1].state, "output-available");
});

test("a turn continuing the last assistant message builds on a copy of it", async () => {
  const original = {
    id: "a1",
    parts: [{ state: "done", text: "Asked.", type: "text" }],
    role: "assistant",
  };
  const request = [{ id: "u1", parts: [], role: "user" }, original];
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream, { originalMessages: request });
  turn.write(
    { messageId: "a1", type: "start" },
    { id: "t2", type: "text-start" },
    { delta: " Answered.", id: "t2", type: "text-delta" },
    { id: "t2", type: "text-end" },
  );
  turn.close();
  await done;
  const final = reports.at(-1).message;
  assert.equal(final.id, "a1");
  assert.equal(textOf(final), "Asked. Answered.");
  assert.equal(original.parts.length, 1, "the request is not changed");
});

test("a continuing turn that writes nothing reports the message it continues", async () => {
  const original = { id: "a1", parts: [], role: "assistant" };
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream, {
    originalMessages: [original],
  });
  turn.close();
  await done;
  assert.deepEqual(
    reports.map((report) => [report.final, report.message.id]),
    [[true, "a1"]],
  );
  assert.notEqual(reports[0].message, original);
});

test("a turn after a user message is a new message, and an empty one is not reported", async () => {
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream, {
    originalMessages: [{ id: "u1", parts: [], role: "user" }],
  });
  turn.close();
  await done;
  assert.equal(reports.length, 0);
});

test("an error chunk does not stop the message being followed", async () => {
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream);
  turn.write(
    { type: "start" },
    { id: "t", type: "text-start" },
    { delta: "Before.", id: "t", type: "text-delta" },
    { errorText: "Provider hiccup", type: "error" },
    { delta: " After.", id: "t", type: "text-delta" },
    { id: "t", type: "text-end" },
  );
  turn.close();
  await done;
  assert.equal(textOf(reports.at(-1).message), "Before. After.");
});

test("a failed stream is still reported at its end, then rejects", async () => {
  const turn = chunkStream();
  const { done, reports } = follow(turn.stream);
  turn.write(
    { type: "start" },
    { id: "t", type: "text-start" },
    { delta: "Partial", id: "t", type: "text-delta" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  turn.fail(new Error("socket closed"));
  await assert.rejects(done, /socket closed/);
  assert.equal(reports.at(-1).final, true);
  assert.equal(textOf(reports.at(-1).message), "Partial");
});

test("a failed report before the end does not stop the turn being followed", async () => {
  vi.useFakeTimers();
  const turn = chunkStream();
  const reports = [];
  const done = followTurnMessage(turn.stream, {
    intervalMs: 100,
    report: (message, { final }) => {
      reports.push({ final, text: textOf(message) });
      if (!final) throw new Error("disk full");
    },
  });
  turn.write(
    { type: "start" },
    { id: "t", type: "text-start" },
    { delta: "a", id: "t", type: "text-delta" },
  );
  await vi.advanceTimersByTimeAsync(100);
  turn.write({ delta: "b", id: "t", type: "text-delta" });
  await vi.advanceTimersByTimeAsync(100);
  turn.close();
  await done;
  assert.deepEqual(
    reports.map((report) => report.text),
    ["a", "ab", "ab"],
  );
});
