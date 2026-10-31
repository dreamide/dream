/**
 * Hono-based API server for Dream IDE.
 *
 * JSON routes share one handler (shared/json-route.js) and validate with zod
 * schemas; the renderer's route client (src/lib/api-client.ts) takes its
 * request types from the same schemas.
 *
 * This file is loaded by the Electron main process at startup.
 *
 * Two listeners serve the same host services. The local one (this file's
 * startApiServer) answers this machine's own clients with the launch token.
 * The remote one (remote-app.js) answers paired devices by their sessions,
 * under an explicit route policy; routes only this machine may call are not
 * registered on it at all.
 */

import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { LOCAL_PRINCIPAL } from "../host/auth/host-auth.js";
import { setBrowserMcpEndpoint } from "./browser-bridge.js";
import {
  BROWSER_MCP_PATH,
  registerBrowserMcpRoutes,
} from "./browser-mcp-routes.js";
import { registerBrowserToolCallRoutes } from "./browser-tool-call-routes.js";
import { registerCatalogRoutes } from "./catalog-routes.js";
import { ORCHESTRATION_MCP_PATH } from "./chat/delegation.js";
import { registerChatRoutes } from "./chat-routes.js";
import { registerCheckpointRoutes } from "./checkpoint-routes.js";
import { registerCodePullRequestRoutes } from "./code-pull-request-routes.js";
import { registerHostDirectoryRoutes } from "./host-directory-routes.js";
import { registerHostInfoRoute } from "./host-info-routes.js";
import {
  isProxiedHostSocketPath,
  registerHostProxyRoutes,
} from "./host-proxy-routes.js";
import {
  HOST_SOCKET_PATH,
  registerHostSocketRoutes,
} from "./host-socket-routes.js";
import { registerMcpServerRoutes } from "./mcp-server-routes.js";
import { registerProjectGitRoutes } from "./project-git-routes.js";
import { registerProviderRoutes } from "./provider-routes.js";
import { registerRemoteAccessRoutes } from "./remote-access-routes.js";
import { trackRequestActivity } from "./shared/request-activity.js";
import { API_SESSION_TOKEN_HEADER } from "./shared/session-token.js";
import { registerSkillsRoutes } from "./skills-routes.js";
import { registerTerminalRoutes } from "./terminal-routes.js";
import { registerToolApprovalRoutes } from "./tool-approvals.js";

export {
  API_SESSION_TOKEN_HEADER,
  createApiSessionToken,
} from "./shared/session-token.js";

// ---------------------------------------------------------------------------
// Routes, shared by both listeners
// ---------------------------------------------------------------------------

/**
 * Registers the host's routes on `app`. With `remote`, only those a paired
 * device may reach (host/auth/route-policy.js lists them): not host-info,
 * the agents' MCP endpoints, the window's browser or the SSH proxy.
 * @param {import("hono").Hono} app
 * @param {object} deps what startApiServer documents
 * @param {{ remote: boolean, publicOrigins?: () => string[] }} options
 */
export function registerHostRoutes(
  app,
  {
    auth,
    delegation,
    scheduler,
    catalog,
    resolveRemoteHost,
    turns,
    getHostDescriptor,
    signHostProof,
    getHostInfo,
    hostSocket,
    terminals,
    remoteAccess,
    onShutdownRequest,
  },
  { remote, publicOrigins },
) {
  if (!remote) {
    // A daemon asked to stop by its local operator (`dream-host stop`):
    // answered first, then the host closes and flushes its writes.
    if (onShutdownRequest) {
      app.post("/api/host/shutdown", (c) => {
        setTimeout(() => onShutdownRequest("requested"), 0);
        return c.json({ shuttingDown: true });
      });
    }
    registerHostInfoRoute(app, getHostInfo);
    if (delegation)
      app.all(ORCHESTRATION_MCP_PATH, (c) => delegation.handle(c.req.raw));
    // Projects on other hosts, through this one (see host-proxy-routes.js).
    if (resolveRemoteHost) {
      registerHostProxyRoutes(app, {
        resolveHost: resolveRemoteHost,
        upgradeWebSocket,
      });
    }
    registerBrowserMcpRoutes(app);
    registerBrowserToolCallRoutes(app);
  }
  registerHostDirectoryRoutes(app);
  if (catalog)
    registerCatalogRoutes(app, catalog, { describeHost: getHostDescriptor });
  registerToolApprovalRoutes(app);
  registerProviderRoutes(app);
  registerChatRoutes(app, { catalog, turns, scheduler });
  registerProjectGitRoutes(app);
  registerCodePullRequestRoutes(app);
  registerCheckpointRoutes(app);
  registerMcpServerRoutes(app);
  registerSkillsRoutes(app);
  registerTerminalRoutes(app, terminals);
  if (auth) {
    registerRemoteAccessRoutes(app, {
      auth,
      describeHost: getHostDescriptor,
      signHostProof,
      publicOrigins,
      remote,
      remoteAccess: remoteAccess ?? null,
    });
  }
  registerHostSocketRoutes(app, { ...hostSocket, auth, upgradeWebSocket });
}

/**
 * Serves `app` on `hostname:port`, WebSocket upgrades included. Resolves
 * with the port and `close`, which drops socket clients and stops it.
 * @param {import("hono").Hono} app
 * @param {{ hostname: string, port: number, onListening?: (port: number) => void }} options
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function serveApp(app, { hostname, port, onListening }) {
  const webSocketServer = new WebSocketServer({ noServer: true });
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname,
        port,
        websocket: { server: webSocketServer },
      },
      (info) => {
        server.off("error", failToListen);
        onListening?.(info.port);
        resolve({
          port: info.port,
          close: () =>
            new Promise((done) => {
              for (const client of webSocketServer.clients) client.terminate();
              webSocketServer.close();
              server.close(() => done(undefined));
              server.closeAllConnections?.();
            }),
        });
      },
    );
    // A port already in use (or not allowed) fails this listener, not the
    // process: the caller reports it.
    const failToListen = (error) => {
      webSocketServer.close();
      reject(error);
    };
    server.once("error", failToListen);
  });
}

// ---------------------------------------------------------------------------
// The local listener
// ---------------------------------------------------------------------------

function createApiApp(deps) {
  const { activity, apiToken, delegation } = deps;
  if (!apiToken) {
    throw new Error("API session token is required to start the API server.");
  }

  const guardedApp = new Hono();

  guardedApp.use("/api/*", async (c, next) => {
    // The host socket checks a one-time ticket instead (see
    // host-socket-routes.js): a browser WebSocket cannot send this header.
    if (
      c.req.path === HOST_SOCKET_PATH ||
      (delegation && c.req.path === ORCHESTRATION_MCP_PATH) ||
      isProxiedHostSocketPath(c.req.path)
    ) {
      await next();
      return;
    }

    if (c.req.header(API_SESSION_TOKEN_HEADER) !== apiToken) {
      return c.text("Unauthorized", 401);
    }

    // The launch token is this machine's own operator: every scope.
    c.set("principal", LOCAL_PRINCIPAL);
    await next();
  });

  if (activity) {
    trackRequestActivity(guardedApp, activity, {
      skipPaths: [HOST_SOCKET_PATH],
    });
  }

  registerHostRoutes(guardedApp, deps, {
    publicOrigins: deps.publicOrigins,
    remote: false,
  });
  return guardedApp;
}

/**
 * Starts the host's API server on loopback. Resolves with the port it
 * listens on and `close`, which drops socket clients and stops listening.
 *
 * `catalog` serves the catalog routes (host/catalog.js). `resolveRemoteHost`
 * enables `/api/hosts/:hostId/*`, forwarded to that host's endpoint.
 * `getHostInfo` answers `GET /api/host-info`; `getHostDescriptor` (the
 * host's identity and protocol) is listed with the catalog. `hostSocket` is
 * `{ socket, tickets }` for the host socket (host-socket-routes.js).
 * `auth`, the host's device sessions (host/auth/host-auth.js), serves the
 * remote-access management routes and binds socket tickets; without it
 * there are none. `publicOrigins` names the origins the remote listener is
 * served at (a proof's audience). `activity`, when given, is told
 * when each request begins and ends (see shared/request-activity.js).
 */
export function startApiServer({ port, publicOrigins, ...deps }) {
  const guardedApp = createApiApp({ ...deps, publicOrigins });
  const { apiToken, delegation } = deps;
  return serveApp(guardedApp, {
    hostname: "127.0.0.1",
    port,
    onListening: (listening) => {
      delegation?.setEndpoint(`http://127.0.0.1:${listening}`);
      console.log(`API server listening on http://127.0.0.1:${listening}`);
      // External agent CLIs reach the browser tools here; the token guard
      // on /api/* applies, so the header travels with the server config.
      setBrowserMcpEndpoint({
        headers: { [API_SESSION_TOKEN_HEADER]: apiToken },
        url: `http://127.0.0.1:${listening}${BROWSER_MCP_PATH}`,
      });
    },
  });
}
