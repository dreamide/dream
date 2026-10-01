import { expect, test, vi } from "vitest";
import { createFakeHostSocket } from "./host-socket-fake";
import { createTerminalClient } from "./terminal-client";

const setup = () => {
  const fake = createFakeHostSocket();
  const api = {
    terminalDiagnostics: vi.fn(async () => []),
    terminalShells: vi.fn(async () => []),
    terminalStart: vi.fn(async () => ({ status: "running" })),
    terminalStop: vi.fn(async () => true),
    terminalStopAll: vi.fn(async () => true),
  };
  const client = createTerminalClient({ api, socket: fake.socket });
  return { ...fake, api, client };
};

const data = (sequence: number, chunk: string) => ({
  channel: "terminal",
  type: "data",
  sessionId: "s1",
  generation: "g1",
  sequence,
  chunk,
});

test("listening opens the host socket", async () => {
  const { client, flush, transports } = setup();
  client.onData(() => {});
  await flush();
  expect(transports).toHaveLength(1);
});

test("a started session resumes from its beginning, input after", async () => {
  const { client, flush, transports } = setup();
  client.onData(() => {});
  await client.start({ cwd: "/p", sessionId: "s1" });
  client.sendInput({ sessionId: "s1", data: "ls\r" });
  await flush();

  transports[0].open();

  expect(transports[0].sent).toEqual([
    {
      channel: "host",
      type: "resume",
      cursors: {
        terminal: [{ sessionId: "s1", generation: null, sequence: 0 }],
      },
    },
    { channel: "terminal", type: "input", sessionId: "s1", data: "ls\r" },
  ]);
});

test("delivers output once, dropping batches already received", async () => {
  const { client, flush, transports } = setup();
  const chunks: string[] = [];
  client.onData((event) => chunks.push(event.chunk));
  await flush();
  transports[0].open();

  transports[0].deliver(data(1, "a"));
  transports[0].deliver(data(2, "b"));
  transports[0].deliver(data(2, "b"));
  transports[0].deliver({
    channel: "terminal",
    type: "data",
    sessionId: "s1",
    chunk: "notice",
  });

  expect(chunks).toEqual(["a", "b", "notice"]);
});

test("reconnects from where each session stopped", async () => {
  const { client, flush, timers, transports } = setup();
  const statuses: string[] = [];
  client.onData(() => {});
  client.onStatus((event) => statuses.push(event.status));
  await flush();
  transports[0].open();
  transports[0].deliver(data(4, "x"));
  transports[0].deliver({
    channel: "terminal",
    type: "status",
    sessionId: "s2",
    status: "stopped",
  });

  transports[0].close();
  client.acknowledge({ sessionId: "s1", generation: "g1", sequence: 4 });
  timers[0]();
  await flush();
  transports[1].open();

  expect(statuses).toEqual(["stopped"]);
  expect(transports[1].sent).toEqual([
    {
      channel: "host",
      type: "resume",
      cursors: {
        terminal: [{ sessionId: "s1", generation: "g1", sequence: 4 }],
      },
    },
    {
      channel: "terminal",
      type: "ack",
      sessionId: "s1",
      generation: "g1",
      sequence: 4,
    },
  ]);
});

test("stop-all can outlive the page", async () => {
  const { api, client } = setup();
  await client.stopAll({ keepalive: true });
  expect(api.terminalStopAll).toHaveBeenCalledWith({}, { keepalive: true });
});
