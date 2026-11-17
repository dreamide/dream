// A logical host connection over the SSH route adapter, with a fake SSH host
// manager: the readiness sequence runs over the link, and the pinned host is
// the supervisor's.
import { expect, test } from "vitest";
import { createDesktopHostConnections } from "./desktop-connections.js";

const HOST_A = { hostId: "host_a", fingerprint: "SHA256:a" };

const createFakeSsh = () => {
  const states = new Map();
  return ({ onStatus }) => ({
    connect: async ({ hostId }) => {
      states.set(hostId, "connected");
      return {
        baseUrl: "http://127.0.0.1:5555",
        token: "daemon-token",
        hostProtocolVersion: 1,
        version: "1.2.3",
        ...HOST_A,
      };
    },
    getState: (key) => states.get(key) ?? "idle",
    forwardPort: async () => 6001,
    disconnect: (key) => {
      if (states.get(key) === "connected") {
        states.set(key, "disconnected");
        onStatus({ hostId: key, state: "disconnected" });
      }
    },
    disconnectAll: async () => {},
  });
};

const DEVBOX = [{ id: "ssh:devbox", kind: "ssh", target: "devbox" }];

const catalog = (host, status = 200) =>
  new Response(JSON.stringify({ host: { hostProtocolVersion: 1, ...host } }), {
    status,
  });

test("an SSH route is made ready through the catalog and pins its host", async () => {
  const probes = [];
  const statuses = [];
  const connections = createDesktopHostConnections({
    createSsh: createFakeSsh(),
    fetchImpl: async (url, init) => {
      probes.push({ url, token: init.headers["x-dream-api-token"] });
      return catalog(HOST_A);
    },
    onPrompt: async () => null,
    onStatus: (status) => statuses.push(status),
  });

  const endpoint = await connections.connect({
    hostId: "devbox",
    routes: DEVBOX,
  });

  expect(endpoint).toMatchObject({ ...HOST_A, routeId: "ssh:devbox" });
  expect(probes).toEqual([
    { url: "http://127.0.0.1:5555/api/catalog", token: "daemon-token" },
  ]);
  expect(statuses.at(-1)).toMatchObject({
    hostId: "devbox",
    state: "connected",
    endpoint: { version: "1.2.3" },
  });
  expect(() =>
    connections.connect({
      hostId: "devbox",
      routes: DEVBOX,
      expectedIdentity: { hostId: "host_b", fingerprint: "SHA256:b" },
    }),
  ).toThrow(/pinned to a different host identity/);
  connections.disconnect("devbox");
  expect(connections.getState("devbox")).toBe("idle");
});

test("an SSH route whose catalog refuses the token is blocked", async () => {
  const connections = createDesktopHostConnections({
    createSsh: createFakeSsh(),
    fetchImpl: async () => catalog(HOST_A, 401),
    onPrompt: async () => null,
  });

  await expect(
    connections.connect({ hostId: "devbox", routes: DEVBOX }),
  ).rejects.toThrow("The route refused catalog access (401).");
  expect(connections.getRouteState("devbox")).toMatchObject({
    state: "failed",
    refusal: "unauthorized",
    routes: [{ routeId: "ssh:devbox", state: "blocked" }],
  });
  connections.disconnect("devbox");
});
