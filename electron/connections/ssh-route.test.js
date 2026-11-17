// The SSH route adapter over a fake SSH host manager: one SSH connection per
// link, prompts under the connection's host, a lost session reported once
// the link is open, and the daemon's token on every request.
import { expect, test } from "vitest";
import { createSshRoutes } from "./ssh-route.js";

const ENDPOINT = {
  baseUrl: "http://127.0.0.1:5555",
  token: "daemon-token",
  hostId: "host_a",
  fingerprint: "SHA256:a",
  hostProtocolVersion: 1,
};

const createFakeSsh = () => {
  const fake = { connects: [], disconnected: [], states: new Map() };
  const createSsh = ({ onPrompt, onStatus }) => {
    fake.prompt = onPrompt;
    fake.status = onStatus;
    return {
      connect: async (options) => {
        fake.connects.push(options);
        fake.states.set(options.hostId, "connected");
        return ENDPOINT;
      },
      getState: (key) => fake.states.get(key) ?? "idle",
      forwardPort: async (key, port) => ({ key, port }),
      disconnect: (key) => fake.disconnected.push(key),
      disconnectAll: async () => {},
    };
  };
  return { fake, createSsh };
};

const openOptions = (overrides = {}) => ({
  signal: new AbortController().signal,
  background: false,
  onLost: () => {},
  ...overrides,
});

test("each link is its own SSH connection, and a background probe is silent", async () => {
  const { fake, createSsh } = createFakeSsh();
  const routes = createSshRoutes({ createSsh, onPrompt: async () => null });

  const first = await routes.open(
    "devbox",
    { id: "ssh:devbox", target: "devbox" },
    openOptions(),
  );
  await routes.open(
    "devbox",
    { id: "ssh:devbox", target: "devbox" },
    openOptions({ background: true }),
  );

  expect(first.endpoint).toBe(ENDPOINT);
  expect(first.authorize).toBeUndefined();
  expect(
    fake.connects.map(({ hostId, interactive, target }) => ({
      hostId,
      interactive,
      target,
    })),
  ).toEqual([
    { hostId: "devbox:1", interactive: true, target: "devbox" },
    { hostId: "devbox:2", interactive: false, target: "devbox" },
  ]);
  expect(await first.forwardPort(3000)).toEqual({
    key: "devbox:1",
    port: 3000,
  });
  first.close();
  first.close();
  expect(fake.disconnected).toEqual(["devbox:1", "devbox:1"]);
});

test("a prompt is asked under the connection's host id", async () => {
  const { fake, createSsh } = createFakeSsh();
  const asked = [];
  const routes = createSshRoutes({
    createSsh,
    onPrompt: async (prompt) => {
      asked.push(prompt);
      return "secret";
    },
  });
  await routes.open("devbox", { id: "ssh", target: "devbox" }, openOptions());

  expect(await fake.prompt({ hostId: "devbox:1", message: "Password:" })).toBe(
    "secret",
  );
  expect(await fake.prompt({ hostId: "gone:9", message: "Password:" })).toBe(
    "secret",
  );
  expect(asked).toEqual([
    { hostId: "devbox", message: "Password:" },
    { hostId: null, message: "Password:" },
  ]);
});

test("a session that ends after opening reports the link lost; a closed link stays quiet", async () => {
  const { fake, createSsh } = createFakeSsh();
  const routes = createSshRoutes({ createSsh, onPrompt: async () => null });
  const lost = [];
  const link = await routes.open(
    "devbox",
    { id: "ssh", target: "devbox" },
    openOptions({ onLost: (error) => lost.push(error.message) }),
  );

  fake.status({ hostId: "devbox:1", state: "connected" });
  fake.status({
    hostId: "devbox:1",
    state: "disconnected",
    error: "The SSH connection closed.",
  });
  expect(lost).toEqual(["The SSH connection closed."]);

  link.close();
  fake.status({ hostId: "devbox:1", state: "disconnected" });
  expect(lost).toHaveLength(1);
});

test("requests carry the daemon's token", async () => {
  const { createSsh } = createFakeSsh();
  const sent = [];
  const routes = createSshRoutes({
    createSsh,
    onPrompt: async () => null,
    fetchImpl: async (url, init) => {
      sent.push({ url, headers: init.headers });
      return new Response("{}");
    },
  });
  const link = await routes.open(
    "devbox",
    { id: "ssh", target: "devbox" },
    openOptions(),
  );

  await link.request(`${ENDPOINT.baseUrl}/api/catalog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(sent).toEqual([
    {
      url: "http://127.0.0.1:5555/api/catalog",
      headers: {
        "content-type": "application/json",
        "x-dream-api-token": "daemon-token",
      },
    },
  ]);
});

test("aborting the attempt ends its SSH connection", async () => {
  const { fake, createSsh } = createFakeSsh();
  const routes = createSshRoutes({ createSsh, onPrompt: async () => null });
  const controller = new AbortController();
  await routes.open(
    "devbox",
    { id: "ssh", target: "devbox" },
    openOptions({ signal: controller.signal }),
  );

  controller.abort();

  expect(fake.disconnected).toEqual(["devbox:1"]);
});
