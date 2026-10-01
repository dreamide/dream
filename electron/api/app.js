/**
 * Hono-based API server for Dream IDE.
 *
 * JSON routes share one handler (shared/json-route.js) and validate with zod
 * schemas; the renderer's route client (src/lib/api-client.ts) takes its
 * request types from the same schemas.
 *
 * This file is loaded by the Electron main process at startup.
 */

import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { setBrowserMcpEndpoint } from "./browser-bridge.js";
import {
  BROWSER_MCP_PATH,
  registerBrowserMcpRoutes,
} from "./browser-mcp-routes.js";
import { registerChatRoutes } from "./chat-routes.js";
import { registerCheckpointRoutes } from "./checkpoint-routes.js";
import { registerCodePullRequestRoutes } from "./code-pull-request-routes.js";
import { registerHostInfoRoute } from "./host-info-routes.js";
import { registerMcpServerRoutes } from "./mcp-server-routes.js";
import { registerProjectGitRoutes } from "./project-git-routes.js";
import { registerProviderRoutes } from "./provider-routes.js";
import { trackRequestActivity } from "./shared/request-activity.js";
import { API_SESSION_TOKEN_HEADER } from "./shared/session-token.js";
import { registerSkillsRoutes } from "./skills-routes.js";
import {
  registerTerminalRoutes,
  TERMINAL_SOCKET_PATH,
} from "./terminal-routes.js";
import { registerToolApprovalRoutes } from "./tool-approvals.js";

export {
  API_SESSION_TOKEN_HEADER,
  createApiSessionToken,
} from "./shared/session-token.js";

// ---------------------------------------------------------------------------
// Exported start function
// ---------------------------------------------------------------------------

function createApiApp({ activity, apiToken, getHostInfo, terminals }) {
  if (!apiToken) {
    throw new Error("API session token is required to start the API server.");
  }

  const guardedApp = new Hono();

  guardedApp.use("/api/*", async (c, next) => {
    // The terminal socket checks a one-time ticket instead (see
    // terminal-routes.js): a browser WebSocket cannot send this header.
    if (c.req.path === TERMINAL_SOCKET_PATH) {
      await next();
      return;
    }

    if (c.req.header(API_SESSION_TOKEN_HEADER) !== apiToken) {
      return c.text("Unauthorized", 401);
    }

    await next();
  });

  if (activity) {
    trackRequestActivity(guardedApp, activity, {
      skipPaths: [TERMINAL_SOCKET_PATH],
    });
  }

  registerHostInfoRoute(guardedApp, getHostInfo);
  registerToolApprovalRoutes(guardedApp);
  registerProviderRoutes(guardedApp);
  registerChatRoutes(guardedApp);
  registerProjectGitRoutes(guardedApp);
  registerCodePullRequestRoutes(guardedApp);
  registerCheckpointRoutes(guardedApp);
  registerMcpServerRoutes(guardedApp);
  registerSkillsRoutes(guardedApp);
  registerBrowserMcpRoutes(guardedApp);
  registerTerminalRoutes(guardedApp, { ...terminals, upgradeWebSocket });

  return guardedApp;
}

/**
 * Starts the host's API server on loopback. Resolves with the port it
 * listens on and `close`, which drops socket clients and stops listening.
 *
 * `getHostInfo` answers `GET /api/host-info`. `activity`, when given, is told
 * when each request begins and ends (see shared/request-activity.js).
 */
export function startApiServer({
  activity,
  apiToken,
  getHostInfo,
  port,
  terminals,
}) {
  const guardedApp = createApiApp({
    activity,
    apiToken,
    getHostInfo,
    terminals,
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: guardedApp.fetch,
        hostname: "127.0.0.1",
        port,
        websocket: { server: webSocketServer },
      },
      (info) => {
        console.log(`API server listening on http://127.0.0.1:${info.port}`);
        // External agent CLIs reach the browser tools here; the token guard
        // on /api/* applies, so the header travels with the server config.
        setBrowserMcpEndpoint({
          headers: { [API_SESSION_TOKEN_HEADER]: apiToken },
          url: `http://127.0.0.1:${info.port}${BROWSER_MCP_PATH}`,
        });
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
  });
}
