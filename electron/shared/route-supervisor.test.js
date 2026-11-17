// The route supervisor over a fake route adapter: what makes a link ready,
// what blocks a route, the pinned host, and dialing again after a loss.
import { expect, test } from "vitest";
import { HOST_PROTOCOL_VERSION } from "../host/protocol.js";
import { createRouteSupervisor } from "./route-supervisor.js";

const HOST_A = { hostId: "host_a", fingerprint: "SHA256:a" };
const HOST_B = { hostId: "host_b", fingerprint: "SHA256:b" };
// Attempt timeouts are set beyond the timers a test moves to.
const DAY = 24 * 60 * 60_000;

/** Timers and time the test moves by hand. */
const createClock = () => {
  let time = 1_000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, ms) => {
      const id = ++nextId;
      timers.set(id, { callback, at: time + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    random: () => 0.5,
    /** Moves time to the next timer that is not an attempt timeout. */
    advance() {
      const [id, timer] = [...timers]
        .filter(([, { at }]) => at - time < DAY)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      timers.delete(id);
      time = Math.max(time, timer.at);
      timer.callback();
    },
    pending: () =>
      [...timers.values()].filter(({ at }) => at - time < DAY).length,
  };
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A fake adapter. `reaches(route, attempt)` says which host a link reaches
 * and how it answers: `{ host, catalogStatus?, catalogHost?, authorize? }`.
 */
const createFakeAdapter = (reaches) => {
  const opened = [];
  const open = async (route, options) => {
    const attempt = opened.filter((link) => link.route === route).length;
    const reply = reaches(route, attempt);
    const requests = [];
    const link = {
      route,
      options,
      requests,
      closed: false,
      endpoint: {
        baseUrl: `http://${route.id}`,
        hostProtocolVersion: HOST_PROTOCOL_VERSION,
        ...reply.host,
      },
      request: async (url) => {
        requests.push(url);
        return json(
          {
            host: {
              hostProtocolVersion: HOST_PROTOCOL_VERSION,
              ...(reply.catalogHost ?? reply.host),
            },
          },
          reply.catalogStatus ?? 200,
        );
      },
      ...(reply.authorize
        ? { authorize: async () => new Response(null, reply.authorize) }
        : {}),
      close() {
        link.closed = true;
      },
    };
    opened.push(link);
    return link;
  };
  return { open, opened };
};

const supervise = ({ routes = [{ id: "ssh" }], reaches, ...options }) => {
  const clock = createClock();
  const adapter = createFakeAdapter(reaches);
  const statuses = [];
  const supervisor = createRouteSupervisor({
    routes,
    open: adapter.open,
    onStatus: (status) => statuses.push(status),
    attemptTimeoutMs: DAY,
    ...clock,
    ...options,
  });
  return { adapter, clock, statuses, supervisor };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a ready link is selected, its endpoint names the route, and its host is pinned", async () => {
  const { adapter, supervisor } = supervise({
    reaches: () => ({ host: HOST_A }),
  });

  const endpoint = await supervisor.connect();

  expect(endpoint).toMatchObject({ ...HOST_A, routeId: "ssh" });
  expect(supervisor.getState().state).toBe("connected");
  expect(supervisor.getLink()).toBe(adapter.opened[0]);
  expect(supervisor.getPinnedIdentity()).toEqual(HOST_A);
  expect(adapter.opened[0].requests).toEqual(["http://ssh/api/catalog"]);
  expect(adapter.opened[0].options).toMatchObject({
    background: false,
    expectedIdentity: null,
  });
});

test("a lost link cools its route down, then the supervisor dials it again", async () => {
  const { adapter, clock, supervisor } = supervise({
    reaches: () => ({ host: HOST_A }),
  });
  await supervisor.connect();
  const [first] = adapter.opened;

  first.options.onLost(new Error("The SSH connection closed."));
  await settle();

  expect(first.closed).toBe(true);
  expect(supervisor.getEndpoint()).toBeNull();
  expect(supervisor.getState()).toMatchObject({
    state: "reconnecting",
    error: "The SSH connection closed.",
    routes: [{ routeId: "ssh", state: "cooldown" }],
  });
  expect(adapter.opened).toHaveLength(1);

  clock.advance();
  await settle();

  expect(adapter.opened).toHaveLength(2);
  expect(supervisor.getState().state).toBe("connected");
  expect(supervisor.getLink()).toBe(adapter.opened[1]);
  // The retry expects the host the first link reached.
  expect(adapter.opened[1].options.expectedIdentity).toEqual(HOST_A);
});

test("a failure that is not a refusal is retried", async () => {
  const { adapter, clock, supervisor } = supervise({
    reaches: (_route, attempt) => ({
      host: HOST_A,
      catalogStatus: attempt === 1 ? 503 : 200,
    }),
  });
  await supervisor.connect();
  adapter.opened[0].options.onLost();
  await settle();

  clock.advance();
  await settle();
  expect(supervisor.getState()).toMatchObject({
    state: "reconnecting",
    refusal: null,
    routes: [
      { state: "cooldown", error: "The route refused catalog access (503)." },
    ],
  });

  clock.advance();
  await settle();
  expect(supervisor.getState().state).toBe("connected");
});

test.each([
  [
    "the catalog probe",
    { catalogStatus: 401 },
    "The route refused catalog access (401).",
  ],
  [
    "the catalog probe",
    { catalogStatus: 403 },
    "The route refused catalog access (403).",
  ],
  [
    "authorization",
    { authorize: { status: 401 } },
    "The route refused access (401).",
  ],
])("a 401 or 403 from %s blocks the route until an explicit connect", async (_step, reply, message) => {
  const { adapter, clock, supervisor } = supervise({
    reaches: () => ({ host: HOST_A, ...reply }),
  });

  await expect(supervisor.connect()).rejects.toThrow(message);

  expect(supervisor.getState()).toMatchObject({
    state: "failed",
    refusal: "unauthorized",
    routes: [{ state: "blocked" }],
  });
  expect(adapter.opened[0].closed).toBe(true);
  expect(clock.pending()).toBe(0);
  // An explicit connect tries it again.
  await expect(supervisor.connect()).rejects.toThrow(message);
  expect(adapter.opened).toHaveLength(2);
});

test("a refusal after authorization skips the catalog probe", async () => {
  const { adapter, supervisor } = supervise({
    reaches: () => ({ host: HOST_A, authorize: { status: 403 } }),
  });
  await expect(supervisor.connect()).rejects.toThrow(
    "The route refused access (403).",
  );
  expect(adapter.opened[0].requests).toEqual([]);
});

test.each([
  [
    "speaks an unsupported protocol",
    { catalogHost: { ...HOST_A, hostProtocolVersion: 99 } },
    /protocol 99/,
    "protocol",
  ],
  [
    "lists another host in its catalog",
    { catalogHost: HOST_B },
    "The route's catalog does not match its verified host.",
    "identity",
  ],
])("a host that %s is refused for good", async (_case, reply, message, refusal) => {
  const { supervisor } = supervise({
    reaches: () => ({ host: HOST_A, ...reply }),
  });
  await expect(supervisor.connect()).rejects.toThrow(message);
  expect(supervisor.getState()).toMatchObject({
    state: "failed",
    refusal,
    routes: [{ state: "blocked" }],
  });
});

test("a host that is not the expected one is refused before its catalog is read", async () => {
  const { adapter, supervisor } = supervise({
    expectedIdentity: HOST_A,
    reaches: () => ({ host: HOST_B }),
  });

  await expect(supervisor.connect()).rejects.toThrow(
    "This route reaches a different host than the saved connection.",
  );
  expect(adapter.opened[0].options.expectedIdentity).toEqual(HOST_A);
  expect(adapter.opened[0].requests).toEqual([]);
  expect(supervisor.getState()).toMatchObject({
    state: "failed",
    refusal: "identity",
    routes: [{ state: "blocked" }],
  });
});

test("after a loss, a route that now reaches another host is blocked and the pin kept", async () => {
  const { adapter, clock, supervisor } = supervise({
    reaches: (_route, attempt) => ({ host: attempt === 0 ? HOST_A : HOST_B }),
  });
  await supervisor.connect();
  adapter.opened[0].options.onLost();
  await settle();

  clock.advance();
  await settle();

  expect(supervisor.getState()).toMatchObject({
    state: "failed",
    refusal: "identity",
    routes: [{ state: "blocked" }],
  });
  expect(supervisor.getPinnedIdentity()).toEqual(HOST_A);
  expect(adapter.opened[1].closed).toBe(true);
});

test("a link lost before it is ready fails that attempt with the reason", async () => {
  const clock = createClock();
  const lost = Object.assign(new Error("The grant was revoked."), {
    fatal: true,
  });
  let closed = false;
  const supervisor = createRouteSupervisor({
    routes: [{ id: "https" }],
    open: async (_route, { onLost }) => ({
      endpoint: { baseUrl: "https://host", ...HOST_A },
      request: async () => new Response("{}"),
      authorize: async () => {
        onLost(lost);
        return new Promise(() => {});
      },
      close: () => {
        closed = true;
      },
    }),
    attemptTimeoutMs: DAY,
    ...clock,
  });

  await expect(supervisor.connect()).rejects.toThrow("The grant was revoked.");
  expect(closed).toBe(true);
  // Fatal, but with no reason given: failed, not refused.
  expect(supervisor.getState()).toMatchObject({
    state: "failed",
    refusal: null,
    routes: [{ state: "blocked" }],
  });
});

test("beside other routes, a host without a persistent identity is refused", async () => {
  const { supervisor } = supervise({
    routes: [{ id: "ssh" }, { id: "https" }],
    reaches: () => ({ host: { hostId: null, fingerprint: null } }),
  });
  await expect(supervisor.connect()).rejects.toThrow(
    /Multiple routes require a host with a persistent identity/,
  );
  expect(supervisor.getState().routes.map((route) => route.state)).toEqual([
    "blocked",
    "blocked",
  ]);
});

test("a lost preferred route falls back to the next one", async () => {
  const { adapter, supervisor } = supervise({
    routes: [{ id: "ssh" }, { id: "https" }],
    reaches: () => ({ host: HOST_A }),
  });
  await supervisor.connect();
  expect(supervisor.getEndpoint().routeId).toBe("ssh");

  adapter.opened[0].options.onLost();
  await settle();

  expect(supervisor.getState()).toMatchObject({
    state: "connected",
    routeId: "https",
  });
  expect(adapter.opened[1].options.background).toBe(false);
});

test("a connection is refused only when every route is, and gives its preferred route's reason", async () => {
  const unauthorized = supervise({
    routes: [{ id: "ssh" }, { id: "https" }],
    reaches: (route) =>
      route.id === "ssh"
        ? { host: HOST_A, catalogStatus: 401 }
        : { host: HOST_A, catalogHost: HOST_B },
  });
  await expect(unauthorized.supervisor.connect()).rejects.toThrow();
  expect(unauthorized.supervisor.getState()).toMatchObject({
    state: "failed",
    refusal: "unauthorized",
  });

  const unreachable = supervise({
    routes: [{ id: "ssh" }, { id: "https" }],
    reaches: (route) =>
      route.id === "ssh"
        ? { host: HOST_A, catalogStatus: 503 }
        : { host: HOST_A, catalogHost: HOST_B },
  });
  await expect(unreachable.supervisor.connect()).rejects.toThrow();
  expect(unreachable.supervisor.getState()).toMatchObject({
    state: "failed",
    refusal: null,
  });
});
