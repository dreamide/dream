// Check client paths against the same route assembly used by the host.
import { Hono } from "hono";
import { expect, test } from "vitest";
import { registerHostRoutes } from "../../electron/api/app.js";
import { API_ROUTES } from "./api-client";

test("every client route is registered on the API server", () => {
  const app = new Hono();
  // Enable the local listener's catalog and device-management routes.
  // Services are not invoked: this checks registration, not request handling.
  registerHostRoutes(
    app,
    {
      auth: {},
      catalog: {},
      getHostDescriptor: () => ({}),
      getHostInfo: () => ({}),
      hostSocket: { socket: {}, tickets: {} },
      remoteAccess: {},
      scheduler: {},
      terminals: { detectShells: () => [], sessions: {} },
    },
    { remote: false },
  );

  const served = new Set(
    app.routes.map((route) => `${route.method} ${route.path}`),
  );
  const missing = Object.entries(API_ROUTES)
    .map(([name, route]) => ({ name, key: `${route.method} ${route.path}` }))
    .filter(({ key }) => !served.has(key));

  expect(missing).toEqual([]);
});
