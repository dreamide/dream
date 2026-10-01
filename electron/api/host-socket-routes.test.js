// The host socket over a real API server: a ticket from the guarded route,
// then one WebSocket carrying every channel, with resume.
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { API_SESSION_TOKEN_HEADER, startApiServer } from "./app.js";
import { createHostSocket } from "./host-socket/host-socket.js";
import { HOST_SOCKET_PATH } from "./host-socket-routes.js";
import { createSocketTickets } from "./shared/socket-tickets.js";

const apiToken = "test-token";
let server = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const startServer = async () => {
  const calls = [];
  const hostSocket = createHostSocket();
  hostSocket.terminals.bindSessions({
    acknowledgeTerminalOutput: (payload) => calls.push(["ack", payload]),
    resizeTerminal: (payload) => calls.push(["resize", payload]),
    writeTerminalInput: (payload) => calls.push(["input", payload]),
  });
  server = await startApiServer({
    apiToken,
    hostSocket: { socket: hostSocket, tickets: createSocketTickets() },
    port: 0,
    terminals: { detectShells: () => [], sessions: {} },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    calls,
    hostSocket,
    socketUrl: `${base.replace("http", "ws")}${HOST_SOCKET_PATH}`,
  };
};

const getTicket = async (base) => {
  const response = await fetch(`${base}/api/host-socket-ticket`, {
    body: "{}",
    headers: {
      "Content-Type": "application/json",
      [API_SESSION_TOKEN_HEADER]: apiToken,
    },
    method: "POST",
  });
  return (await response.json()).ticket;
};

const openSocket = (url) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    socket.once("open", () => resolve({ socket, messages }));
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`HTTP ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting.");
};

test("the socket needs a one-time ticket", async () => {
  const { base, socketUrl } = await startServer();

  await expect(openSocket(`${socketUrl}?ticket=forged`)).rejects.toThrow(
    "HTTP 401",
  );
  const ticket = await getTicket(base);
  const { socket } = await openSocket(`${socketUrl}?ticket=${ticket}`);
  await expect(openSocket(`${socketUrl}?ticket=${ticket}`)).rejects.toThrow(
    "HTTP 401",
  );
  socket.close();
});

test("one socket carries terminals and catalog events both ways", async () => {
  const { base, calls, hostSocket, socketUrl } = await startServer();
  const { socket, messages } = await openSocket(
    `${socketUrl}?ticket=${await getTicket(base)}`,
  );

  socket.send(
    JSON.stringify({
      channel: "host",
      type: "resume",
      cursors: { catalog: null, terminal: [] },
    }),
  );
  await waitFor(() => messages.length === 1);
  expect(messages[0]).toMatchObject({ channel: "catalog", type: "reset" });

  hostSocket.terminals.publish("terminal:data", {
    sessionId: "s1",
    generation: "g1",
    sequence: 1,
    chunk: "hi",
  });
  hostSocket.catalog.publish({ kind: "chat-created", chatId: "c1" });
  await waitFor(() => messages.length === 3);
  expect(messages[1]).toMatchObject({ channel: "terminal", chunk: "hi" });
  expect(messages[2]).toMatchObject({
    channel: "catalog",
    event: { chatId: "c1", kind: "chat-created" },
    seq: 1,
    type: "event",
  });

  socket.send(
    JSON.stringify({
      channel: "terminal",
      type: "input",
      sessionId: "s1",
      data: "x",
    }),
  );
  await waitFor(() => calls.length === 1);
  expect(calls[0]).toEqual(["input", { sessionId: "s1", data: "x" }]);
  socket.close();
});
