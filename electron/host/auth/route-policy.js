// Which scope each host route needs from a remote client. Each route's
// answer is its `remote` in the route table (shared/host-routes.js); this
// module turns those rows into the remote listener's checks. The remote
// listener serves only the routes the table gives a scope or makes public,
// and refuses to start if it would serve one it does not
// (assertRoutePolicy): a new route is unreachable remotely until its row
// says otherwise.
//
// Some routes are never served remotely at all (`remote: "local"`): the
// host's own diagnostics, endpoints agent CLIs on this machine call with
// run-scoped or launch credentials, the desktop window's browser, the
// desktop's proxy to its SSH hosts, and changing remote access itself.
//
// The host socket's channels are checked the same way, per message
// (socketMessageScope).
import { HOST_ROUTES } from "../../shared/host-routes.js";
import { hasScope, SCOPES } from "./scopes.js";

/** @typedef {import("./scopes.js").Scope} Scope */
/** @typedef {Scope | ((c: import("hono").Context) => Promise<Scope>)} RoutePolicy */

const keyOf = (route) => `${route.method} ${route.path}`;

/**
 * A row's policy: its scope, or for a route whose body names an action,
 * `view` for the actions that only read and the row's scope otherwise.
 * @param {import("../../shared/host-routes.js").HostRouteSpec} route
 * @returns {RoutePolicy}
 */
const policyOf = (route) => {
  const scope = /** @type {Scope} */ (route.remote);
  if (!route.remoteViewActions) return scope;
  const viewActions = new Set(route.remoteViewActions);
  return async (c) => {
    const body = await c.req.json().catch(() => null);
    return viewActions.has(body?.action) ? "view" : scope;
  };
};

const rows = Object.values(HOST_ROUTES);

/**
 * Each remotely served route that needs a session, by `METHOD path`, and
 * the scope it needs.
 * @type {Readonly<Record<string, RoutePolicy>>}
 */
export const REMOTE_ROUTE_POLICY = Object.freeze(
  Object.fromEntries(
    rows
      .filter((route) => SCOPES.includes(route.remote))
      .map((route) => [keyOf(route), policyOf(route)]),
  ),
);

/** Routes anyone may call: they grant nothing without a secret. */
export const PUBLIC_REMOTE_ROUTES = Object.freeze(
  rows.filter((route) => route.remote === "public").map(keyOf),
);

const compile = (pattern) =>
  new RegExp(
    `^${pattern
      .split("/")
      .map((part) =>
        part === "*"
          ? ".*"
          : part.startsWith(":")
            ? "[^/]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/")}$`,
  );

const compiled = Object.entries(REMOTE_ROUTE_POLICY).map(([key, policy]) => {
  const [method, pattern] = key.split(" ");
  return { matches: compile(pattern), method, policy };
});

/**
 * The scope a remote request needs, or null for a route not served
 * remotely.
 * @param {import("hono").Context} c
 * @returns {Promise<Scope | null>}
 */
export const requiredScope = async (c) => {
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  const entry = compiled.find(
    (candidate) =>
      candidate.method === method && candidate.matches.test(c.req.path),
  );
  if (!entry) return null;
  return typeof entry.policy === "function" ? entry.policy(c) : entry.policy;
};

/**
 * Throws unless every route `app` serves (besides its middleware) has a
 * policy or is public: no route reaches remote clients by default.
 * @param {import("hono").Hono} app
 * @param {{ middlewarePaths: string[] }} options
 */
export const assertRoutePolicy = (app, { middlewarePaths }) => {
  const known = new Set([
    ...Object.keys(REMOTE_ROUTE_POLICY),
    ...PUBLIC_REMOTE_ROUTES,
  ]);
  const unclassified = app.routes
    .filter(
      (route) =>
        !(route.method === "ALL" && middlewarePaths.includes(route.path)),
    )
    .map((route) => `${route.method} ${route.path}`)
    .filter((key) => !known.has(key));
  if (unclassified.length > 0) {
    throw new Error(
      `Routes without a remote access policy: ${[...new Set(unclassified)].join(", ")}. Give each a remote scope in electron/shared/host-routes.js.`,
    );
  }
};

/**
 * The scope one host socket message needs from a remote client, or null
 * when remote clients may not send it at all.
 *   terminal  output is followed with view; input and resizing operate
 *   catalog   view
 *   browser   local only: a remote client cannot run an agent's browser
 *             tools (there is no host-owned browser yet)
 *   resume    view, per channel
 * @param {string} channel
 * @param {{ type?: unknown }} message
 * @returns {Scope | null}
 */
export const socketMessageScope = (channel, message) => {
  if (channel === "browser") return null;
  if (channel === "terminal") {
    return message.type === "input" || message.type === "resize"
      ? "operate"
      : "view";
  }
  if (channel === "catalog" || channel === "host") return "view";
  return null;
};

/**
 * Whether `scopes` may send this socket message.
 * @param {readonly string[]} scopes
 * @param {string} channel
 * @param {{ type?: unknown }} message
 */
export const allowsSocketMessage = (scopes, channel, message) => {
  const scope = socketMessageScope(channel, message);
  return scope !== null && hasScope(scopes, scope);
};
