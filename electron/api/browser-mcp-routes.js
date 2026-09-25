import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getBrowserBridge } from "./browser-bridge.js";
import { getActiveBrowserTurnProjectId } from "./chat/active-browser-turns.js";
import {
  BROWSER_MCP_SERVER_NAME,
  createBrowserToolDefinitions,
} from "./chat/browser-tools.js";

/**
 * Streamable HTTP MCP endpoint exposing Dream's browser tools to agent CLIs
 * that cannot host an in-process MCP server (Codex, OpenCode, ACP adapters).
 *
 *   POST /api/mcp/browser/:projectId   project-scoped (OpenCode, ACP)
 *   POST /api/mcp/browser              shared; project = running Codex turn
 *
 * The endpoint is stateless: every request gets a fresh McpServer/transport
 * pair and a plain JSON response, so no per-client session bookkeeping is
 * needed and the shared Codex app-server can keep one config for its whole
 * lifetime. Requests are already authenticated by the `/api/*` token guard.
 */

export const BROWSER_MCP_PATH = "/api/mcp/browser";

export const createBrowserMcpRequestHandler = ({
  bridge,
  projectId,
  projectResolver,
}) => {
  const server = new McpServer({
    name: BROWSER_MCP_SERVER_NAME,
    version: "1.0.0",
  });
  const tools = createBrowserToolDefinitions({
    bridge,
    projectId: projectId ?? projectResolver,
  });
  for (const [name, def] of Object.entries(tools)) {
    server.registerTool(
      name,
      {
        ...(def.annotations ? { annotations: def.annotations } : {}),
        description: def.description,
        inputSchema: def.inputSchema.shape,
      },
      (args, extra) => def.handler(args ?? {}, extra),
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  return async (request) => {
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // JSON mode: the response body is complete once handleRequest resolves.
      void server.close().catch(() => {});
    }
  };
};

export const registerBrowserMcpRoutes = (app) => {
  const handle = async (c) => {
    const bridge = getBrowserBridge();
    if (!bridge) {
      return c.json(
        { error: "The Dream browser bridge is not available." },
        503,
      );
    }
    const projectId = c.req.param("projectId") || null;
    const handler = createBrowserMcpRequestHandler({
      bridge,
      projectId,
      projectResolver: () =>
        getActiveBrowserTurnProjectId({ provider: "openai" }) ??
        getActiveBrowserTurnProjectId(),
    });
    return handler(c.req.raw);
  };

  app.all(`${BROWSER_MCP_PATH}/:projectId`, handle);
  app.all(BROWSER_MCP_PATH, handle);
};
