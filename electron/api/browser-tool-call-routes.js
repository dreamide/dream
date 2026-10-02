// `POST /api/browser-tools/call`: runs one browser tool on this window's
// browser, for an agent on an SSH host. The host sends the call over its
// socket to the window that has the project open; the window's renderer
// hands it here, where the browser bridge lives, and sends the result back
// (host-socket/browser-relay.js, src/lib/browser-relay-client.ts).
import { z } from "zod";
import { getBrowserBridge } from "./browser-bridge.js";
import { createBrowserToolDefinitions } from "./chat/browser-tools.js";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";

export const browserToolCallRequestSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
  projectId: z.string().min(1),
  tool: z.string().min(1),
});

/**
 * Runs `tool` for `projectId` on `bridge`; resolves with the tool's result
 * (MCP content), which reports a failure in the tool itself as an error
 * result rather than throwing.
 */
export const runBrowserToolCall = async ({ bridge, projectId, tool, args }) => {
  const definitions = createBrowserToolDefinitions({ bridge, projectId });
  const definition = Object.hasOwn(definitions, tool)
    ? definitions[tool]
    : null;
  if (!definition) {
    throw new RouteError(`Unknown browser tool ${tool}.`, 404);
  }
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new RouteError(parsed.error.message, 400);
  }
  return definition.handler(parsed.data, {});
};

/** @param {import("hono").Hono} app */
export function registerBrowserToolCallRoutes(app) {
  app.post("/api/browser-tools/call", (c) =>
    handleJsonRoute(
      c,
      browserToolCallRequestSchema,
      ({ args, projectId, tool }) => {
        const bridge = getBrowserBridge();
        if (!bridge) {
          throw new RouteError("This process has no browser.", 503);
        }
        return runBrowserToolCall({ args, bridge, projectId, tool });
      },
      { errorMessage: "The browser tool failed." },
    ),
  );
}
