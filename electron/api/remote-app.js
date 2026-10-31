// The remote listener: the host's API for paired devices, beside the local
// listener (app.js) and calling the same host services. Nothing here
// trusts the network a request came over; the device's session decides.
//
// Every request, in order:
//   1. Host   must be one of the public origins' hosts (a forwarded host
//             only when `trustForwardedHost` says a reverse proxy, such as
//             Tailscale Serve, sets it). Stops DNS rebinding.
//   2. Origin when a browser sends one, must be a public origin; and
//             `Sec-Fetch-Site: cross-site` is refused outright.
//   3. Session a bearer token or the session cookie. A cookie-carried
//             request that is not a GET must name its Origin (CSRF).
//             The pairing routes alone need none (PUBLIC_REMOTE_ROUTES);
//             the host socket is authorized by its ticket instead.
//   4. Scope  the route policy (host/auth/route-policy.js): a route it
//             does not list is not found; one above the session's scopes
//             is forbidden.
// A response body a session holds open (a chat stream) is closed when the
// session is revoked. Secrets travel in headers, cookies and bodies only,
// never in URLs, and nothing here logs a request.
import { Hono } from "hono";
import {
  assertRoutePolicy,
  PUBLIC_REMOTE_ROUTES,
  requiredScope,
} from "../host/auth/route-policy.js";
import { hasScope } from "../host/auth/scopes.js";
import { registerHostRoutes, serveApp } from "./app.js";
import { createClientAssets } from "./client-assets.js";
import { HOST_SOCKET_PATH } from "./host-socket-routes.js";
import {
  clearSessionCookie,
  readSessionCredential,
} from "./remote-access-routes.js";
import { trackRequestActivity } from "./shared/request-activity.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `https://host:port` as an origin, or null when it is not one. */
const toOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

/**
 * Wraps `response` so its body ends when `principal`'s session is revoked.
 * The host work behind it (a running turn) carries on: only this client's
 * view of it closes.
 */
export const closableOnRevoke = (response, principal, auth) => {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let controller = null;
  let untrack = () => {};
  const finish = () => {
    untrack();
    untrack = () => {};
  };
  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      untrack = auth.track(principal, () => {
        finish();
        controller.error(new Error("The session was revoked."));
        reader.cancel("revoked").catch(() => undefined);
      });
    },
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          streamController.close();
        } else {
          streamController.enqueue(value);
        }
      } catch (error) {
        finish();
        streamController.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/**
 * @param {object} deps the host services, as startApiServer takes them, with
 *   `auth` (host/auth/host-auth.js) required.
 * @param {{
 *   origins: () => string[],
 *   advertisedOrigins?: () => string[],
 *   trustForwardedHost: boolean,
 *   clientAssets?: ((c: import("hono").Context) => Response | Promise<Response>) | null,
 * }} options
 *   `origins`: where clients load from (each `scheme://host[:port]`).
 *   `advertisedOrigins`: the ones a client is told to reach (never loopback when
 *   there is a public one); `origins` when absent.
 *   `clientAssets`: serves the browser client for every request no route
 *   answered (client-assets.js); without it those are 404s.
 */
export function createRemoteApiApp(
  deps,
  {
    origins,
    advertisedOrigins = origins,
    trustForwardedHost,
    clientAssets = null,
  },
) {
  const { auth, activity } = deps;
  if (!auth) throw new Error("The remote listener needs the host's auth.");
  const app = new Hono();

  app.use("*", async (c, next) => {
    const allowed = origins();
    const forwarded = trustForwardedHost
      ? c.req.header("x-forwarded-host")?.split(",")[0]?.trim()
      : null;
    const host = forwarded || c.req.header("host");
    if (!host || !allowed.some((origin) => new URL(origin).host === host)) {
      return c.text("Unknown host.", 421);
    }
    const origin = c.req.header("origin");
    if (
      (origin !== undefined && !allowed.includes(origin)) ||
      c.req.header("sec-fetch-site") === "cross-site"
    ) {
      return c.text("Cross-origin requests are not allowed.", 403);
    }
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  });

  app.use("/api/*", async (c, next) => {
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (PUBLIC_REMOTE_ROUTES.includes(`${method} ${c.req.path}`)) {
      await next();
      return;
    }
    // A WebSocket cannot carry an Authorization header: its one-time
    // ticket, bound to the session that asked for it, authorizes it.
    if (c.req.path === HOST_SOCKET_PATH) {
      await next();
      return;
    }

    const carried = readSessionCredential(c);
    const principal = carried
      ? await auth.authenticate(carried.credential)
      : null;
    if (!principal) {
      if (carried?.via === "cookie") clearSessionCookie(c);
      return c.text("Pair this device with the host first.", 401);
    }
    if (
      carried.via === "cookie" &&
      !SAFE_METHODS.has(c.req.method) &&
      c.req.header("origin") === undefined
    ) {
      return c.text("Cross-origin requests are not allowed.", 403);
    }

    const scope = await requiredScope(c);
    if (scope === null) return c.text("Not found.", 404);
    if (!hasScope(principal.scopes, scope)) {
      return c.text(
        `This device's access does not allow that (needs ${scope}).`,
        403,
      );
    }

    c.set("principal", principal);
    await next();
    c.res = closableOnRevoke(c.res, principal, auth);
  });

  if (activity) {
    trackRequestActivity(app, activity, { skipPaths: [HOST_SOCKET_PATH] });
  }

  registerHostRoutes(app, deps, {
    publicOrigins: advertisedOrigins,
    remote: true,
  });
  assertRoutePolicy(app, { middlewarePaths: ["/*", "/api/*"] });
  // Not a route: the client's files answer what no route did, and never
  // anything under /api (an unknown API path stays a 404).
  app.notFound(clientAssets ?? ((c) => c.text("Not found.", 404)));
  return app;
}

/**
 * Starts the remote listener. Without `publicOrigins` it accepts only its
 * own loopback address (for a reverse proxy configured to pass that Host,
 * or for trying it locally); behind a proxy, name the origin clients use.
 * @param {object} deps the host services (see createRemoteApiApp)
 * @param {{
 *   hostname?: string,
 *   port: number,
 *   publicOrigins?: string[],
 *   trustForwardedHost?: boolean,
 *   clientDirectory?: string | null,
 * }} options
 *   `clientDirectory`: the browser client's build, served at the
 *   listener's root (client-assets.js); none when absent or missing.
 * @returns {Promise<{ port: number, origins: string[], close: () => Promise<void> }>}
 */
export async function startRemoteApiServer(
  deps,
  {
    hostname = "127.0.0.1",
    port,
    publicOrigins = [],
    trustForwardedHost = false,
    clientDirectory = null,
  },
) {
  const configured = publicOrigins.map((value) => {
    const origin = toOrigin(value);
    if (!origin) throw new Error(`Not an origin: ${value}`);
    return origin;
  });
  // Accepted: the public origins and the listener's own loopback address
  // (what a reverse proxy on this machine may name as the Host). Advertised
  // as the host's address: the public origins only, so another device is never
  // sent to 127.0.0.1; loopback only when there is no public origin at all
  // (trying the listener on this machine).
  let accepted = configured;
  let advertised = configured;
  const app = createRemoteApiApp(deps, {
    advertisedOrigins: () => advertised,
    clientAssets: await createClientAssets(clientDirectory),
    origins: () => accepted,
    trustForwardedHost,
  });
  const server = await serveApp(app, { hostname, port });
  const loopback = [
    `http://127.0.0.1:${server.port}`,
    `http://localhost:${server.port}`,
  ];
  accepted = [...configured, ...loopback];
  advertised = configured.length > 0 ? configured : loopback;
  return { ...server, origins: advertised };
}
