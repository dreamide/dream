import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishDevSession } from "../electron/dev-inspection.js";

export const devInspectionPlugin = () => ({
  name: "dream-dev-inspection",
  apply: "serve",
  configureServer(server) {
    server.httpServer?.once("listening", () => {
      const address = server.httpServer.address();
      if (!address || typeof address === "string") return;
      void publishDevSession(server.config.root, {
        kind: "vite",
        rendererUrl: `http://127.0.0.1:${address.port}`,
        apiUrl: `http://127.0.0.1:${process.env.ELECTRON_API_PORT ?? 3211}`,
      }).catch((error) =>
        server.config.logger.warn(`Cannot publish dev session: ${error}`),
      );
    });
    server.middlewares.use(async (request, response, next) => {
      if (request.url?.split("?")[0] !== "/__dev/fixtures") return next();
      try {
        // Reuse the app's font and theme definitions without its boot scripts,
        // which consult the real preload and saved UI preferences.
        const index = await readFile(
          path.join(server.config.root, "index.html"),
          "utf8",
        );
        const head = index
          .match(/<head>([\s\S]*?)<\/head>/)?.[1]
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
          .replace(
            /<title>[\s\S]*?<\/title>/,
            "<title>Dream UI fixtures</title>",
          );
        if (!head) throw new Error("App document head not found");
        const html = await server.transformIndexHtml(
          "/__dev/fixtures",
          `<!doctype html><html lang="en" data-base-color="zinc"><head>${head}</head><body class="antialiased"><div id="root"></div><script type="module" src="/src/dev/fixtures.tsx"></script></body></html>`,
        );
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      } catch (error) {
        next(error);
      }
    });
  },
});
