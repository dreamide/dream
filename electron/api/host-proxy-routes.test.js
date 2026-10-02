// Projects on another host, through this one: two real API servers, the
// "local" one forwarding /api/hosts/devbox/* to the "remote" one with the
// remote's token, the host socket included.
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { API_SESSION_TOKEN_HEADER, startApiServer } from "./app.js";
import { createHostSocket } from "./host-socket/host-socket.js";
import { createSocketTickets } from "./shared/socket-tickets.js";

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const start = async ({ apiToken, catalog, resolveRemoteHost }) => {
  const hostSocket = createHostSocket();
  const server = await startApiServer({
    apiToken,
    catalog,
    getHostInfo: () => ({ hostProtocolVersion: 1, pid: apiToken }),
    hostSocket: { socket: hostSocket, tickets: createSocketTickets() },
    port: 0,
    resolveRemoteHost,
    terminals: { detectShells: () => [], sessions: {} },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, hostSocket };
};

const setup = async () => {
  const received = [];
  const remote = await start({
    apiToken: "remote-token",
    catalog: {
      applyChanges: async (changes, { origin }) => {
        received.push({ changes, origin });
        return {
          chatIds: [],
          conflicts: [],
          projectIds: [],
          removedChatIds: [],
          removedProjectIds: [],
        };
      },
      getTranscript: () => [],
      list: () => ({ chats: [], projects: [{ id: "remote-project" }] }),
      saveTranscript: async () => true,
    },
  });
  const local = await start({
    apiToken: "local-token",
    resolveRemoteHost: (hostId) =>
      hostId === "devbox"
        ? { baseUrl: remote.base, token: "remote-token" }
        : null,
  });
  const post = (path, body, token = "local-token") =>
    fetch(`${local.base}${path}`, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "x-dream-client-id": "window-1",
        ...(token ? { [API_SESSION_TOKEN_HEADER]: token } : {}),
      },
      method: "POST",
    });
  return { local, post, received, remote };
};

test("a request for an SSH host reaches it with the host's own token", async () => {
  const { post, received } = await setup();

  const catalog = await post("/api/hosts/devbox/catalog", {});
  expect(await catalog.json()).toEqual({
    chats: [],
    projects: [{ id: "remote-project" }],
  });

  await post("/api/hosts/devbox/catalog/changes", { removedChatIds: ["c1"] });
  // The window's id travels; the local token does not (the remote checks
  // its own, which the local API added).
  expect(received).toEqual([
    { changes: { removedChatIds: ["c1"] }, origin: "window-1" },
  ]);
});

test("the proxy is behind the local token, and an unknown host is unavailable", async () => {
  const { post } = await setup();

  expect((await post("/api/hosts/devbox/catalog", {}, null)).status).toBe(401);
  const unknown = await post("/api/hosts/elsewhere/catalog", {});
  expect(unknown.status).toBe(503);
  expect(await unknown.text()).toBe("Host is not connected.");
});

test("an SSH host's socket is proxied, its ticket checked by that host", async () => {
  const { local, post, remote } = await setup();
  const { ticket } = await (
    await post("/api/hosts/devbox/host-socket-ticket", {})
  ).json();

  const socket = new WebSocket(
    `${local.base.replace("http", "ws")}/api/hosts/devbox/host-socket?ticket=${ticket}`,
  );
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      channel: "host",
      cursors: { catalog: null },
      type: "resume",
    }),
  );

  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 1000 && !check(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor(() => messages.length > 0);
  remote.hostSocket.catalog.publish({ kind: "changes", origin: "elsewhere" });
  await waitFor(() => messages.length > 1);
  socket.close();

  expect(messages[0]).toMatchObject({ channel: "catalog", type: "reset" });
  expect(messages[1]).toMatchObject({
    channel: "catalog",
    event: { kind: "changes" },
    type: "event",
  });
});
