import { HOST_ROUTES } from "../shared/host-routes.js";
import { resolveSharedBrowserProject } from "./chat/browser-attach.js";
import {
  BROWSER_MCP_SERVER_NAME,
  createAvailableBrowserToolDefinitions,
} from "./chat/browser-tools.js";
import { createMcpRequestHandler } from "./shared/mcp-handler.js";
import { registerRoute } from "./shared/register-route.js";

/**
 * Streamable HTTP MCP endpoint exposing Dream's browser tools to agent CLIs
 * that cannot host an in-process MCP server (Codex, OpenCode, ACP adapters).
 *
 *   POST /api/mcp/browser/:projectId   project-url turns (OpenCode, ACP)
 *   POST /api/mcp/browser              shared-url turns (Codex); the project
 *                                      is the turn's that made the call
 *                                      (resolveSharedBrowserProject)
 *
 * The endpoint is stateless: every request gets a fresh McpServer/transport
 * pair and a plain JSON response, so no per-client session bookkeeping is
 * needed and the shared Codex app-server can keep one config for its whole
 * lifetime. Requests are already authenticated by the `/api/*` token guard.
 */

export const BROWSER_MCP_PATH = HOST_ROUTES.browserMcp.path;

/**
 * @param {{ tools: Record<string, any> }} options the browser tool
 *   definitions to serve (createAvailableBrowserToolDefinitions).
 */
export const createBrowserMcpRequestHandler = ({ tools }) =>
  createMcpRequestHandler({ name: BROWSER_MCP_SERVER_NAME, tools });

/** A non-empty string, or null. */
const idOf = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The Provider session a shared-endpoint call names: the thread id Codex
 * puts in an MCP tool call's `_meta`, as `threadId`, or inside its turn
 * metadata (`x-codex-turn-metadata`, an object or its JSON text) as
 * `thread_id`. Null for anything else (a batch, a request without a JSON
 * body, a call naming no thread), which takes the guess.
 * @param {Request} request
 * @returns {Promise<string | null>}
 */
const readCallSessionId = async (request) => {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  const meta = body?.params?._meta;
  if (!meta || typeof meta !== "object") return null;
  let turn = meta["x-codex-turn-metadata"];
  if (typeof turn === "string") {
    try {
      turn = JSON.parse(turn);
    } catch {
      turn = null;
    }
  }
  return idOf(meta.threadId) ?? idOf(turn?.thread_id) ?? idOf(turn?.threadId);
};

export const registerBrowserMcpRoutes = (app) => {
  const handle = async (c) => {
    // This process's browser (the desktop app), or a window's through the
    // host socket (a host daemon on an SSH host).
    const projectId = c.req.param("projectId") || null;
    const sessionId = projectId ? null : await readCallSessionId(c.req.raw);
    const tools = createAvailableBrowserToolDefinitions({
      projectId:
        projectId ?? (() => resolveSharedBrowserProject({ sessionId })),
    });
    if (!tools) {
      return c.json(
        { error: "The Dream browser bridge is not available." },
        503,
      );
    }
    return createBrowserMcpRequestHandler({ tools })(c.req.raw);
  };

  registerRoute(app, HOST_ROUTES.browserMcpProject, handle);
  registerRoute(app, HOST_ROUTES.browserMcp, handle);
};
