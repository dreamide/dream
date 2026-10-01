import { expect, test } from "vitest";
import { createTerminalStream } from "./terminal-stream.js";

const createClient = () => {
  const received = [];
  return { received, send: (text) => received.push(JSON.parse(text)) };
};

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

test("broadcasts output and status to every connected client", () => {
  const stream = createTerminalStream();
  const first = createClient();
  const second = createClient();
  stream.connect(first);
  stream.connect(second);

  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "hello"));

  for (const client of [first, second]) {
    expect(client.received).toEqual([
      { type: "status", ...running("s1") },
      { type: "data", ...batch("s1", 1, "hello") },
    ]);
  }
});

test("a closed client receives nothing more", () => {
  const stream = createTerminalStream();
  const client = createClient();
  const connection = stream.connect(client);
  connection.close();

  stream.publish("terminal:data", batch("s1", 1, "hello"));

  expect(client.received).toEqual([]);
  expect(stream.getClientCount()).toBe(0);
});

test("resume replays only the batches after the client's cursor", () => {
  const stream = createTerminalStream();
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "a"));
  stream.publish("terminal:data", batch("s1", 2, "b"));
  stream.publish("terminal:data", batch("s1", 3, "c"));

  const client = createClient();
  stream.connect(client).receive(
    JSON.stringify({
      type: "resume",
      sessions: [{ sessionId: "s1", generation: "g1", sequence: 1 }],
    }),
  );

  expect(client.received).toEqual([
    { type: "status", ...running("s1") },
    { type: "data", ...batch("s1", 2, "b") },
    { type: "data", ...batch("s1", 3, "c") },
  ]);
});

test("resume from an unknown generation replays everything retained", () => {
  const stream = createTerminalStream();
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "a", "g2"));

  const client = createClient();
  stream.connect(client).receive(
    JSON.stringify({
      type: "resume",
      sessions: [{ sessionId: "s1", generation: null, sequence: 0 }],
    }),
  );

  expect(client.received.at(-1)).toEqual({
    type: "data",
    ...batch("s1", 1, "a", "g2"),
  });
});

test("resume reports a session that ended while the client was away", () => {
  const stream = createTerminalStream();
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "a"));
  stream.publish("terminal:status", { sessionId: "s1", status: "stopped" });

  const client = createClient();
  stream.connect(client).receive(
    JSON.stringify({
      type: "resume",
      sessions: [{ sessionId: "s1", generation: "g1", sequence: 0 }],
    }),
  );

  expect(client.received).toEqual([
    { type: "status", sessionId: "s1", status: "stopped" },
  ]);
});

test("keeps output within the replay budget and flags the gap", () => {
  const stream = createTerminalStream({ replayBudget: 4 });
  stream.publish("terminal:status", running("s1"));
  stream.publish("terminal:data", batch("s1", 1, "aa"));
  stream.publish("terminal:data", batch("s1", 2, "bb"));
  stream.publish("terminal:data", batch("s1", 3, "cc"));

  const client = createClient();
  stream.connect(client).receive(
    JSON.stringify({
      type: "resume",
      sessions: [{ sessionId: "s1", generation: "g1", sequence: 0 }],
    }),
  );

  const data = client.received.filter((message) => message.type === "data");
  expect(data[0].chunk).toContain("dropped");
  expect(data.slice(1).map((message) => message.sequence)).toEqual([2, 3]);
});

test("routes input, resizes and acknowledgments to the sessions", () => {
  const calls = [];
  const stream = createTerminalStream();
  stream.bindSessions({
    acknowledgeTerminalOutput: (payload) => calls.push(["ack", payload]),
    resizeTerminal: (payload) => calls.push(["resize", payload]),
    writeTerminalInput: (payload) => calls.push(["input", payload]),
  });
  const connection = stream.connect(createClient());

  connection.receive(
    JSON.stringify({ type: "input", sessionId: "s1", data: "ls\r" }),
  );
  connection.receive(
    JSON.stringify({ type: "resize", sessionId: "s1", cols: 80, rows: 24 }),
  );
  connection.receive(
    JSON.stringify({
      type: "ack",
      sessionId: "s1",
      generation: "g1",
      sequence: 3,
    }),
  );
  connection.receive("not json");

  expect(calls).toEqual([
    ["input", { sessionId: "s1", data: "ls\r" }],
    ["resize", { sessionId: "s1", cols: 80, rows: 24 }],
    ["ack", { sessionId: "s1", generation: "g1", sequence: 3 }],
  ]);
});
