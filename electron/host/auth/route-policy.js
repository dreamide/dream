// Which scope each host route needs from a remote client, written out route
// by route. The remote listener serves exactly the routes listed here and
// refuses to start if it would serve one that is not (assertRoutePolicy):
// a new route is unreachable remotely until someone decides its scope.
//
// Some routes are never served remotely at all (LOCAL_ONLY_ROUTES): the
// host's own diagnostics, endpoints agent CLIs on this machine call with
// run-scoped or launch credentials, the desktop window's browser, and the
// desktop's proxy to its SSH hosts.
//
// The host socket's channels are checked the same way, per message
// (socketMessageScope).
import { hasScope } from "./scopes.js";

/** @typedef {import("./scopes.js").Scope} Scope */
/** @typedef {Scope | ((c: import("hono").Context) => Promise<Scope>)} RoutePolicy */

/** Pull request actions that only read. */
const PULL_REQUEST_READS = new Set([
  "comments",
  "context",
  "detail",
  "files",
  "list",
  "mergeInfo",
  "reviews",
  "threads",
]);

/** Never served by the remote listener. */
export const LOCAL_ONLY_ROUTES = Object.freeze([
  // A daemon's clean stop, for its local operator.
  "POST /api/host/shutdown",
  // Process id and platform: the descriptor is the remote's view of a host.
  "GET /api/host-info",
  // Agent CLIs on this host, with run-scoped or launch credentials.
  "ALL /api/mcp/orchestration",
  "ALL /api/mcp/browser",
  "ALL /api/mcp/browser/:projectId",
  // The desktop window's own browser.
  "POST /api/browser-tools/call",
  // The desktop's forwarding to its SSH hosts.
  "ALL /api/hosts/:hostId/*",
]);

/** @type {Readonly<Record<string, RoutePolicy>>} */
export const REMOTE_ROUTE_POLICY = Object.freeze({
  // Host catalog
  "POST /api/catalog": "view",
  "POST /api/catalog/search": "view",
  "POST /api/catalog/transcript": "view",
  "POST /api/catalog/transcript/page": "view",
  "POST /api/catalog/changes": "operate",
  "PUT /api/catalog/transcript": "operate",

  // Chats, runs and approvals
  "GET /api/chat/:chatId/stream": "view",
  "POST /api/chat/queue": "view",
  "POST /api/chat": "operate",
  "POST /api/chat/submit": "operate",
  "POST /api/chat/queue/control": "operate",
  "POST /api/chat/stop": "operate",
  "POST /api/chat-title": "operate",
  "POST /api/tool-approval-response": "operate",

  // Files
  "POST /api/host-directories": "operate",
  "POST /api/project-directory": "view",
  "POST /api/project-files": "view",
  "POST /api/project-file": "view",
  "GET /api/project-file-raw": "view",
  "POST /api/project-search": "view",
  "POST /api/project-icon": "view",
  "PUT /api/project-file": "operate",

  // Git
  "POST /api/project-git-status": "view",
  "POST /api/project-git-branches": "view",
  "POST /api/project-git-worktrees": "view",
  "POST /api/project-git-remote-url": "view",
  "POST /api/project-git-push-preview": "view",
  "POST /api/project-git-log": "view",
  "POST /api/project-git-pull-request-details": "view",
  "POST /api/project-git-worktree-compare": "view",
  "POST /api/project-git-worktree-compare-diff": "view",
  "POST /api/project-git-diff": "view",
  "GET /api/project-git-file-at-head-raw": "view",
  "POST /api/project-git-checkout": "operate",
  "POST /api/project-git-worktree-create": "operate",
  "POST /api/project-git-commit": "operate",
  "POST /api/project-git-commit-message": "operate",
  "POST /api/project-git-push": "operate",
  "POST /api/project-git-fetch": "operate",
  "POST /api/project-git-pull": "operate",
  "POST /api/project-git-create-pr": "operate",
  "POST /api/project-git-worktree-merge": "operate",
  "POST /api/project-git-worktree-cleanup": "operate",
  "POST /api/project-git-revert-file": "operate",
  "POST /api/project-git-revert-all": "operate",
  "POST /api/code-pull-requests": async (c) => {
    const body = await c.req.json().catch(() => null);
    return PULL_REQUEST_READS.has(body?.action) ? "view" : "operate";
  },

  // Checkpoints
  "POST /api/checkpoint-changes": "view",
  "POST /api/checkpoint-diff": "view",
  "POST /api/checkpoint-restore": "operate",
  "POST /api/checkpoint-delete-chats": "operate",

  // Terminals (their output and input travel on the host socket)
  "POST /api/terminal-shells": "view",
  "POST /api/terminal-diagnostics": "view",
  "POST /api/terminal-start": "operate",
  "POST /api/terminal-stop": "operate",
  "POST /api/terminal-stop-all": "operate",

  // Providers, skills and MCP servers
  "POST /api/provider-models": "view",
  "POST /api/provider-usage-limits": "view",
  "POST /api/cli-updates": "view",
  "POST /api/skills": "view",
  "POST /api/skills/read": "view",
  "POST /api/cli-upgrade": "manage",
  "POST /api/skills/create": "manage",
  "POST /api/skills/set-enabled": "manage",
  "POST /api/mcp-servers/import-candidates": "manage",

  // The host socket: the ticket is bound to the session, and each channel
  // message is checked by socketMessageScope.
  "POST /api/host-socket-ticket": "view",
  "GET /api/host-socket": "view",

  // Remote access (remote-access-routes.js). Each checks the caller's own
  // scope too: a device may end its own session, a manager any.
  "GET /api/remote/session": "view",
  "POST /api/remote/session/renew": "view",
  "POST /api/remote/session/end": "view",
  "POST /api/remote/pairings": "manage",
  "POST /api/remote/claims": "manage",
  "POST /api/remote/claims/answer": "manage",
  "POST /api/remote/sessions": "manage",
  "POST /api/remote/sessions/revoke": "manage",

  // The host's own settings and where they came from (Sharing & access).
  "POST /api/host/settings": "manage",
  "POST /api/remote/access": "manage",
});

/** Routes anyone may call: they grant nothing without a secret. */
export const PUBLIC_REMOTE_ROUTES = Object.freeze([
  "POST /api/remote/proof",
  "GET /api/remote/descriptor",
  "POST /api/remote/pair",
  "POST /api/remote/pair/code",
  "POST /api/remote/pair/claim",
]);

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
      `Routes without a remote access policy: ${[...new Set(unclassified)].join(", ")}. Add each to electron/host/auth/route-policy.js.`,
    );
  }
};

/**
 * The scope one host socket message needs from a remote client, or null
 * when remote clients may not send it at all.
 *   terminal  output is followed with view; input and resizing operate
 *   catalog   view
 *   browser   local only: a remote client cannot run an agent's browser
 *             tools (CONN-11 adds a host-owned browser)
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
