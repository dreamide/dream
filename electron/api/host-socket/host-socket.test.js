import { expect, test } from "vitest";
import { createHostSocket } from "./host-socket.js";

const createClient = () => {
  const received = [];
  return { received, send: (text) => received.push(JSON.parse(text)) };
};

test("broadcasts every channel's messages to every connected client", () => {
  const hostSocket = createHostSocket();
  const first = createClient();
  const second = createClient();
  hostSocket.connect(first);
  const closing = hostSocket.connect(second);

  hostSocket.terminals.publish("terminal:status", {
    sessionId: "s1",
    status: "running",
  });
  closing.close();
  hostSocket.catalog.publish({ kind: "chat-created" });

  expect(first.received.map((m) => m.channel)).toEqual(["terminal", "catalog"]);
  expect(second.received.map((m) => m.channel)).toEqual(["terminal"]);
  expect(hostSocket.getClientCount()).toBe(1);
});

test("one resume message resumes every channel for that client only", () => {
  const hostSocket = createHostSocket();
  hostSocket.terminals.publish("terminal:status", {
    sessionId: "s1",
    status: "running",
  });
  hostSocket.terminals.publish("terminal:data", {
    sessionId: "s1",
    generation: "g1",
    sequence: 1,
    chunk: "a",
  });
  hostSocket.catalog.publish({ kind: "x" });
  const bystander = createClient();
  hostSocket.connect(bystander);
  const client = createClient();

  hostSocket.connect(client).receive(
    JSON.stringify({
      channel: "host",
      type: "resume",
      cursors: {
        catalog: hostSocket.catalog.getCursor(),
        terminal: [{ sessionId: "s1", generation: "g1", sequence: 0 }],
      },
    }),
  );

  expect(client.received).toEqual([
    { channel: "terminal", type: "status", sessionId: "s1", status: "running" },
    {
      channel: "terminal",
      type: "data",
      sessionId: "s1",
      generation: "g1",
      sequence: 1,
      chunk: "a",
    },
  ]);
  expect(bystander.received).toEqual([]);
});

test("routes a client's message to its channel and ignores the rest", () => {
  const inputs = [];
  const hostSocket = createHostSocket();
  hostSocket.terminals.bindSessions({
    acknowledgeTerminalOutput: () => {},
    resizeTerminal: () => {},
    writeTerminalInput: (payload) => inputs.push(payload),
  });
  const connection = hostSocket.connect(createClient());

  connection.receive(
    JSON.stringify({
      channel: "terminal",
      type: "input",
      sessionId: "s1",
      data: "ls",
    }),
  );
  connection.receive(JSON.stringify({ channel: "nope", type: "input" }));
  connection.receive("not json");

  expect(inputs).toEqual([{ sessionId: "s1", data: "ls" }]);
});
