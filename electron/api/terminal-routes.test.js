// The terminal routes over a real API server: JSON routes behind the token
// guard, and the terminal socket behind a one-time ticket.
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { API_SESSION_TOKEN_HEADER, startApiServer } from "./app.js";
import { createSocketTickets } from "./shared/socket-tickets.js";
import { TERMINAL_SOCKET_PATH } from "./terminal-routes.js";
import { createTerminalStream } from "./terminals/terminal-stream.js";

const apiToken = "test-token";
let server = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const startServer = async () => {
  const calls = [];
  const stream = createTerminalStream();
  const sessions = {
    acknowledgeTerminalOutput: (payload) => calls.push(["ack", payload]),
    getTerminalOutputDiagnostics: () => [{ sessionId: "s1" }],
    resizeTerminal: (payload) => calls.push(["resize", payload]),
    startTerminal: async (payload) => {
      calls.push(["start", payload]);
      return { status: "running", pid: 7, transport: "pty", shell: "sh" };
    },
    stopAllProcesses: async () => calls.push(["stop-all"]),
    stopTerminalSession: async (sessionId) => calls.push(["stop", sessionId]),
    writeTerminalInput: (payload) => calls.push(["input", payload]),
  };
  stream.bindSessions(sessions);
  server = await startApiServer({
    apiToken,
    port: 0,
    terminals: {
      detectShells: async () => [{ id: "sh", label: "sh", shellPath: "sh" }],
      diagnosticsEnabled: true,
      sessions,
      stream,
      tickets: createSocketTickets(),
    },
  });
  return { calls, stream, base: `http://127.0.0.1:${server.port}` };
};

const post = (base, path, body, token = apiToken) =>
  fetch(`${base}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { [API_SESSION_TOKEN_HEADER]: token } : {}),
    },
    method: "POST",
  });

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

test("JSON routes run the sessions behind the token guard", async () => {
  const { base, calls } = await startServer();

  const started = await post(base, "/api/terminal-start", {
    cwd: "/tmp",
    sessionId: "s1",
  });
  expect(await started.json()).toMatchObject({ status: "running", pid: 7 });

  await post(base, "/api/terminal-stop", { sessionId: "s1" });
  const shells = await post(base, "/api/terminal-shells", {});
  expect(await shells.json()).toEqual([
    { id: "sh", label: "sh", shellPath: "sh" },
  ]);
  expect(calls.map(([name]) => name)).toEqual(["start", "stop"]);

  const refused = await post(base, "/api/terminal-start", {}, null);
  expect(refused.status).toBe(401);
});

test("the socket needs a ticket, then streams both ways", async () => {
  const { base, calls, stream } = await startServer();
  const socketUrl = `${base.replace("http", "ws")}${TERMINAL_SOCKET_PATH}`;

  await expect(openSocket(`${socketUrl}?ticket=forged`)).rejects.toThrow(
    "HTTP 401",
  );

  const { ticket } = await (
    await post(base, "/api/terminal-socket-ticket", {})
  ).json();
  const { socket, messages } = await openSocket(
    `${socketUrl}?ticket=${ticket}`,
  );

  await waitFor(() => stream.getClientCount() === 1);
  stream.publish("terminal:data", {
    sessionId: "s1",
    generation: "g1",
    sequence: 1,
    chunk: "hi",
  });
  await waitFor(() => messages.length === 1);
  expect(messages[0]).toMatchObject({ type: "data", chunk: "hi" });

  socket.send(JSON.stringify({ type: "input", sessionId: "s1", data: "x" }));
  await waitFor(() => calls.length === 1);
  expect(calls[0]).toEqual(["input", { sessionId: "s1", data: "x" }]);

  // A ticket opens one socket only.
  await expect(openSocket(`${socketUrl}?ticket=${ticket}`)).rejects.toThrow(
    "HTTP 401",
  );
  socket.close();
});
