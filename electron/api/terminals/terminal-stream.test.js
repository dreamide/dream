import { expect, test } from "vitest";
import { createTerminalStream } from "./terminal-stream.js";

const running = (sessionId) => ({
  sessionId,
  status: "running",
  transport: "pty",
  shell: "bash -i",
  pid: 42,
});

const batch = (sessionId, sequence, chunk, generation = "g1") => ({
  sessionId,
  generation,
  sequence,
  chunk,
});

const terminal = (type, payload) => ({ channel: "terminal", type, ...payload });

const setup = (options = {}) => {
  const broadcasts = [];
  const stream = createTerminalStream({
    broadcast: (message) => broadcasts.push(message),
    ...options,
  });
  const resume = (cursors) => {
    const sent = [];
    stream.resume((message) => sent.push(message), cursors);
    return sent;
  };
  return { broadcasts, resume, stream };
};

test("broadcasts output and status on the terminal channel", () => {
  const { broadcasts, stream } = setup();

  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "hello"));

  expect(broadcasts).toEqual([
    terminal("status", running("s1")),
    terminal("data", batch("s1", 1, "hello")),
  ]);
});

test("resume replays only the batches after the client's cursor", () => {
  const { resume, stream } = setup();
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "a"));
  stream.publish("terminal:data", batch("s1", 2, "b"));
  stream.publish("terminal:data", batch("s1", 3, "c"));

  expect(resume([{ sessionId: "s1", generation: "g1", sequence: 1 }])).toEqual([
    terminal("status", running("s1")),
    terminal("data", batch("s1", 2, "b")),
    terminal("data", batch("s1", 3, "c")),
  ]);
});

test("resume from an unknown generation replays everything retained", () => {
  const { resume, stream } = setup();
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "a", "g2"));

  expect(
    resume([{ sessionId: "s1", generation: null, sequence: 0 }]).at(-1),
  ).toEqual(terminal("data", batch("s1", 1, "a", "g2")));
});

test("resume reports a session that ended while the client was away", () => {
  const { resume, stream } = setup();
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "a"));
  stream.publish("terminal:status", { sessionId: "s1", status: "stopped" });

  expect(resume([{ sessionId: "s1", generation: "g1", sequence: 0 }])).toEqual([
    terminal("status", { sessionId: "s1", status: "stopped" }),
  ]);
});

test("keeps output within the replay budget and flags the gap", () => {
  const { resume, stream } = setup({ replayBudget: 4 });
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "aa"));
  stream.publish("terminal:data", batch("s1", 2, "bb"));
  stream.publish("terminal:data", batch("s1", 3, "cc"));

  const data = resume([
    { sessionId: "s1", generation: "g1", sequence: 0 },
  ]).filter((message) => message.type === "data");
  expect(data[0].chunk).toContain("dropped");
  expect(data.slice(1).map((message) => message.sequence)).toEqual([2, 3]);
});

test("routes input, resizes and acknowledgments to the sessions", () => {
  const calls = [];
  const { stream } = setup();
  stream.bindSessions({
    acknowledgeTerminalOutput: (payload) => calls.push(["ack", payload]),
    resizeTerminal: (payload) => calls.push(["resize", payload]),
    writeTerminalInput: (payload) => calls.push(["input", payload]),
  });

  stream.receive(terminal("input", { sessionId: "s1", data: "ls\r" }));
  stream.receive(terminal("resize", { sessionId: "s1", cols: 80, rows: 24 }));
  stream.receive(
    terminal("ack", { sessionId: "s1", generation: "g1", sequence: 3 }),
  );
  stream.receive(terminal("input", { data: "no session" }));

  expect(calls).toEqual([
    ["input", { sessionId: "s1", data: "ls\r" }],
    ["resize", { sessionId: "s1", cols: 80, rows: 24 }],
    ["ack", { sessionId: "s1", generation: "g1", sequence: 3 }],
  ]);
});
