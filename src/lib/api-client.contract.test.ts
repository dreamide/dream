// The route client's paths against the routes the server registers: every
// method the renderer can call is one the API server answers.
import { Hono } from "hono";
import { expect, test } from "vitest";
import { API_ROUTES } from "./api-client";

test("every client route is registered on the API server", async () => {
  const [
    { registerBrowserToolCallRoutes },
    { registerCatalogRoutes },
    { registerChatRoutes },
    { registerCheckpointRoutes },
    { registerCodePullRequestRoutes },
    { registerHostDirectoryRoutes },
    { registerMcpServerRoutes },
    { registerProjectGitRoutes },
    { registerProviderRoutes },
    { registerHostSocketRoutes },
    { registerSkillsRoutes },
    { registerTerminalRoutes },
    { registerToolApprovalRoutes },
  ] = await Promise.all([
    import("../../electron/api/browser-tool-call-routes.js"),
    import("../../electron/api/catalog-routes.js"),
    import("../../electron/api/chat-routes.js"),
    import("../../electron/api/checkpoint-routes.js"),
    import("../../electron/api/code-pull-request-routes.js"),
    import("../../electron/api/host-directory-routes.js"),
    import("../../electron/api/mcp-server-routes.js"),
    import("../../electron/api/project-git-routes.js"),
    import("../../electron/api/provider-routes.js"),
    import("../../electron/api/host-socket-routes.js"),
    import("../../electron/api/skills-routes.js"),
    import("../../electron/api/terminal-routes.js"),
    import("../../electron/api/tool-approvals.js"),
  ]);

  const app = new Hono();
  for (const register of [
    registerBrowserToolCallRoutes,
    registerChatRoutes,
    registerCheckpointRoutes,
    registerCodePullRequestRoutes,
    registerHostDirectoryRoutes,
    registerMcpServerRoutes,
    registerProjectGitRoutes,
    registerProviderRoutes,
    registerSkillsRoutes,
    registerToolApprovalRoutes,
  ]) {
    register(app);
  }
  registerTerminalRoutes(app, {
    detectShells: () => [],
    sessions: {} as never,
  });
  registerCatalogRoutes(app, {} as never);
  registerHostSocketRoutes(app, {
    socket: {} as never,
    tickets: {} as never,
  });

  const served = new Set(
    app.routes.map((route) => `${route.method} ${route.path}`),
  );
  const missing = Object.entries(API_ROUTES)
    .map(([name, route]) => ({ name, key: `${route.method} ${route.path}` }))
    .filter(({ key }) => !served.has(key));

  expect(missing).toEqual([]);
});
