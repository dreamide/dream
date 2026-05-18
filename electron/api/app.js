/**
 * Hono-based API server for Dream IDE.
 *
 * Migrated from Next.js App Router route handlers.  Each route keeps the same
 * Request/Response contract so the renderer `fetch("/api/…")` calls work
 * unchanged.
 *
 * This file is loaded by the Electron main process at startup.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { registerChatRoutes } from "./chat-routes.js";
import { registerProjectGitRoutes } from "./project-git-routes.js";
import { registerProviderRoutes } from "./provider-routes.js";
import { registerToolApprovalRoutes } from "./tool-approvals.js";

const app = new Hono();

registerToolApprovalRoutes(app);
registerProviderRoutes(app);
registerChatRoutes(app);
registerProjectGitRoutes(app);

// ---------------------------------------------------------------------------
// Exported start function
// ---------------------------------------------------------------------------

export function startApiServer(port) {
  return new Promise((resolve) => {
    serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port,
      },
      (info) => {
        console.log(`API server listening on http://127.0.0.1:${info.port}`);
        resolve(info.port);
      },
    );
  });
}

export { app };
