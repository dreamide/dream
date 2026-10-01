import { expect, test, vi } from "vitest";
import { createTerminalClient, type TerminalSocket } from "./terminal-client";

class FakeSocket implements TerminalSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: TerminalSocket["onopen"] = null;
  onmessage: TerminalSocket["onmessage"] = null;
  onclose: TerminalSocket["onclose"] = null;
  onerror: TerminalSocket["onerror"] = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const setup = () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const api = {
    terminalDiagnostics: vi.fn(async () => []),
    terminalShells: vi.fn(async () => []),
    terminalSocketTicket: vi.fn(async () => ({ ticket: "t" })),
    terminalStart: vi.fn(async () => ({ status: "running" })),
    terminalStop: vi.fn(async () => true),
    terminalStopAll: vi.fn(async () => true),
  };
  const client = createTerminalClient({
    api,
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => {},
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { api, client, flush, sockets, timers };
};

test("opens the socket with a ticket when someone listens", async () => {
  const { api, client, flush, sockets } = setup();
  expect(sockets).toHaveLength(0);

  client.onData(() => {});
  await flush();

  expect(api.terminalSocketTicket).toHaveBeenCalledTimes(1);
  expect(sockets).toHaveLength(1);
});

test("queues messages until the socket opens, after the resume", async () => {
  const { client, flush, sockets } = setup();
  client.onData(() => {});
  await client.start({ cwd: "/p", sessionId: "s1" });
  client.sendInput({ sessionId: "s1", data: "ls\r" });
  await flush();

  sockets[0].open();

  expect(sockets[0].sent).toEqual([
    {
      type: "resume",
      sessions: [{ sessionId: "s1", generation: null, sequence: 0 }],
    },
    { type: "input", sessionId: "s1", data: "ls\r" },
  ]);
});

test("delivers output once, dropping batches already received", async () => {
  const { client, flush, sockets } = setup();
  const chunks: string[] = [];
  client.onData((event) => chunks.push(event.chunk));
  await flush();
  sockets[0].open();

  const data = { type: "data", sessionId: "s1", generation: "g1" };
  sockets[0].deliver({ ...data, sequence: 1, chunk: "a" });
  sockets[0].deliver({ ...data, sequence: 2, chunk: "b" });
  sockets[0].deliver({ ...data, sequence: 2, chunk: "b" });
  sockets[0].deliver({ type: "data", sessionId: "s1", chunk: "notice" });

  expect(chunks).toEqual(["a", "b", "notice"]);
});

test("reconnects and resumes from where each session stopped", async () => {
  const { client, flush, sockets, timers } = setup();
  const statuses: string[] = [];
  client.onData(() => {});
  client.onStatus((event) => statuses.push(event.status));
  await flush();
  sockets[0].open();
  sockets[0].deliver({
    type: "data",
    sessionId: "s1",
    generation: "g1",
    sequence: 4,
    chunk: "x",
  });
  sockets[0].deliver({
    type: "data",
    sessionId: "s2",
    generation: "g2",
    sequence: 1,
    chunk: "y",
  });
  sockets[0].deliver({ type: "status", sessionId: "s2", status: "stopped" });

  sockets[0].close();
  client.acknowledge({ sessionId: "s1", generation: "g1", sequence: 4 });
  expect(timers).toHaveLength(1);
  timers[0]();
  await flush();
  sockets[1].open();

  expect(statuses).toEqual(["stopped"]);
  expect(sockets[1].sent).toEqual([
    {
      type: "resume",
      sessions: [{ sessionId: "s1", generation: "g1", sequence: 4 }],
    },
    { type: "ack", sessionId: "s1", generation: "g1", sequence: 4 },
  ]);
});

test("stop-all can outlive the page", async () => {
  const { api, client } = setup();
  await client.stopAll({ keepalive: true });
  expect(api.terminalStopAll).toHaveBeenCalledWith({}, { keepalive: true });
});
