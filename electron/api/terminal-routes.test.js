// The terminal routes over a real API server, behind the token guard. Their
// streaming half is the host socket (host-socket-routes.test.js).
import { afterEach, expect, test } from "vitest";
import { API_SESSION_TOKEN_HEADER, startApiServer } from "./app.js";
import { createHostSocket } from "./host-socket/host-socket.js";
import { createSocketTickets } from "./shared/socket-tickets.js";

const apiToken = "test-token";
let server = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const startServer = async () => {
  const calls = [];
  const sessions = {
    getTerminalOutputDiagnostics: () => [{ sessionId: "s1" }],
    startTerminal: async (payload) => {
      calls.push(["start", payload]);
      return { status: "running", pid: 7, transport: "pty", shell: "sh" };
    },
    stopAllProcesses: async () => calls.push(["stop-all"]),
    stopTerminalSession: async (sessionId) => calls.push(["stop", sessionId]),
  };
  server = await startApiServer({
    apiToken,
    hostSocket: { socket: createHostSocket(), tickets: createSocketTickets() },
    port: 0,
    terminals: {
      detectShells: async () => [{ id: "sh", label: "sh", shellPath: "sh" }],
      diagnosticsEnabled: true,
      sessions,
    },
  });
  return { calls, base: `http://127.0.0.1:${server.port}` };
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
  const diagnostics = await post(base, "/api/terminal-diagnostics", {});
  expect(await diagnostics.json()).toEqual([{ sessionId: "s1" }]);
  expect(calls.map(([name]) => name)).toEqual(["start", "stop"]);

  const refused = await post(base, "/api/terminal-start", {}, null);
  expect(refused.status).toBe(401);
});
