// The route table (shared/host-routes.js) against what the host's two
// listeners actually register, built from the same route assembly the host
// starts with (services are fakes and never called: this checks
// registration, not request handling), and the remote route policy read
// from it.
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  assertRoutePolicy,
  PUBLIC_REMOTE_ROUTES,
  REMOTE_ROUTE_POLICY,
  requiredScope,
} from "../host/auth/route-policy.js";
import { HOST_ROUTES, routePath } from "../shared/host-routes.js";
import { registerHostRoutes } from "./app.js";
import { createRemoteApiApp } from "./remote-app.js";

// Every optional service present, so every conditional route is registered.
const services = {
  auth: {},
  catalog: {},
  delegation: { handle: () => new Response(null) },
  getHostDescriptor: () => ({}),
  getHostInfo: () => ({}),
  hostSocket: { socket: {}, tickets: {} },
  onShutdownRequest: () => {},
  remoteAccess: {},
  resolveRemoteHost: () => null,
  scheduler: {},
  terminals: { detectShells: () => [], sessions: {} },
};

const keyOf = (route) => `${route.method} ${route.path}`;

/** `METHOD path` of each route `app` registers, besides its middleware. */
const registered = (app, middlewarePaths = []) =>
  new Set(
    app.routes
      .filter(
        (route) =>
          !(route.method === "ALL" && middlewarePaths.includes(route.path)),
      )
      .map(keyOf),
  );

const localRoutes = () => {
  const app = new Hono();
  registerHostRoutes(app, services, { remote: false });
  return registered(app);
};

// The remote listener as the host builds it, middleware and the startup
// policy check (assertRoutePolicy) included.
const remoteRoutes = () =>
  registered(
    createRemoteApiApp(services, {
      origins: () => ["https://host.example"],
      trustForwardedHost: false,
    }),
    ["/*", "/api/*"],
  );

const rows = Object.values(HOST_ROUTES);
const keysWhere = (keep) => rows.filter(keep).map(keyOf).sort();

describe("the route table", () => {
  test("lists every route either listener registers", () => {
    const listed = new Set(rows.map(keyOf));
    const unlisted = [...localRoutes(), ...remoteRoutes()].filter(
      (key) => !listed.has(key),
    );
    expect(unlisted).toEqual([]);
  });

  test("lists no route that no listener registers", () => {
    const served = new Set([...localRoutes(), ...remoteRoutes()]);
    const unserved = rows.map(keyOf).filter((key) => !served.has(key));
    expect(unserved).toEqual([]);
  });

  test("lists each method and path once", () => {
    const keys = rows.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the local listener serves every route but the public ones", () => {
    expect([...localRoutes()].sort()).toEqual(
      keysWhere((route) => route.remote !== "public"),
    );
  });

  test("the remote listener serves every route but the local-only ones", () => {
    expect([...remoteRoutes()].sort()).toEqual(
      keysWhere((route) => route.remote !== "local"),
    );
  });
});

describe("the remote route policy", () => {
  test("gives each row with a scope that scope, and makes the public rows public", () => {
    expect(Object.keys(REMOTE_ROUTE_POLICY).sort()).toEqual(
      keysWhere((route) =>
        ["view", "operate", "manage"].includes(route.remote),
      ),
    );
    expect([...PUBLIC_REMOTE_ROUTES].sort()).toEqual(
      keysWhere((route) => route.remote === "public"),
    );
    for (const route of rows) {
      if (route.remoteViewActions || !(keyOf(route) in REMOTE_ROUTE_POLICY))
        continue;
      expect(REMOTE_ROUTE_POLICY[keyOf(route)]).toBe(route.remote);
    }
  });

  /** A remote request as requiredScope reads it. */
  const request = (method, path, body = null) => ({
    req: { json: async () => body, method, path },
  });

  test("matches a path's parameters and treats HEAD as GET", async () => {
    const stream = routePath(HOST_ROUTES.chatStream, { chatId: "a b" });
    expect(stream).toBe("/api/chat/a%20b/stream");
    expect(await requiredScope(request("GET", stream))).toBe("view");
    expect(await requiredScope(request("HEAD", stream))).toBe("view");
    expect(await requiredScope(request("POST", stream))).toBeNull();
  });

  test("needs no scope it does not list: local-only, public and unknown routes", async () => {
    const { hostInfo, remoteAccessEnable, remotePairCode } = HOST_ROUTES;
    for (const route of [hostInfo, remoteAccessEnable, remotePairCode]) {
      expect(await requiredScope(request(route.method, route.path))).toBeNull();
    }
    expect(await requiredScope(request("POST", "/api/unknown"))).toBeNull();
  });

  test("asks only view of a pull request action that reads", async () => {
    const { method, path } = HOST_ROUTES.codePullRequests;
    const scopeFor = (body) => requiredScope(request(method, path, body));
    expect(await scopeFor({ action: "list" })).toBe("view");
    expect(await scopeFor({ action: "mergeInfo" })).toBe("view");
    expect(await scopeFor({ action: "merge" })).toBe("operate");
    expect(await scopeFor(null)).toBe("operate");
  });

  test("refuses to start a remote listener serving a route it does not list", () => {
    const unlisted = new Hono();
    unlisted.post("/api/unlisted", (c) => c.text(""));
    expect(() => assertRoutePolicy(unlisted, { middlewarePaths: [] })).toThrow(
      "POST /api/unlisted",
    );

    const localOnly = new Hono();
    localOnly.get(HOST_ROUTES.hostInfo.path, (c) => c.text(""));
    expect(() => assertRoutePolicy(localOnly, { middlewarePaths: [] })).toThrow(
      "GET /api/host-info",
    );
  });
});
