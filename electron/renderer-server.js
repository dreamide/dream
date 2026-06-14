import { spawn as spawnProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import sirv from "sirv";

import { createApiSessionToken, startApiServer } from "./api-server.js";
import { stopChildProcess } from "./process-sessions.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getNodeExecutable() {
  const candidates = [
    process.env.npm_node_execpath,
    process.env.NODE,
    process.env.NODE_BINARY,
    "node",
  ];

  for (const candidate of candidates) {
    const executable = candidate?.trim();
    if (!executable) {
      continue;
    }

    const executableName = path.basename(executable).toLowerCase();
    if (executableName.includes("electron")) {
      continue;
    }

    return executable;
  }

  return "node";
}

export function createRendererServerManager({
  apiServerPort,
  appDir,
  developmentRendererUrl,
  internalRendererPort,
  isDevelopment,
  rendererProbeIntervalMs,
  rendererStartupTimeoutMs,
  rendererUrlFromEnv,
}) {
  const apiSessionToken = createApiSessionToken();

  let rendererUrl = developmentRendererUrl;
  let viteDevProcess = null;
  let productionHttpServer = null;

  async function start() {
    // Always start the API server (Hono) on the API port.
    await startApiServer({ port: apiServerPort, apiToken: apiSessionToken });

    if (isDevelopment) {
      rendererUrl = developmentRendererUrl;

      if (rendererUrlFromEnv) {
        return;
      }

      const projectRoot = path.resolve(appDir, "..");
      const viteCli = path.join(
        projectRoot,
        "node_modules",
        "vite",
        "bin",
        "vite.js",
      );

      viteDevProcess = spawnProcess(
        getNodeExecutable(),
        [
          viteCli,
          "--host",
          "127.0.0.1",
          "--port",
          String(internalRendererPort),
          "--strictPort",
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            BROWSER: "none",
            ELECTRON_API_PORT: String(apiServerPort),
            ELECTRON_INTERNAL_PORT: String(internalRendererPort),
            FORCE_COLOR: "1",
          },
          stdio: "inherit",
        },
      );

      viteDevProcess.on("error", (error) => {
        console.error("Failed to start Vite dev server:", error);
      });

      viteDevProcess.on("close", (code, signal) => {
        console.log(
          `Vite dev server exited (code: ${code ?? "null"}, signal: ${signal ?? "null"}).`,
        );
      });

      const startTime = Date.now();
      let lastError = "not started";

      while (Date.now() - startTime < rendererStartupTimeoutMs) {
        if (
          !viteDevProcess ||
          typeof viteDevProcess.exitCode === "number" ||
          viteDevProcess.signalCode
        ) {
          throw new Error("Vite dev server exited before it became ready.");
        }

        try {
          const response = await fetch(rendererUrl);
          if (response.ok) {
            return;
          }
          lastError = `HTTP ${response.status}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }

        await sleep(rendererProbeIntervalMs);
      }

      throw new Error(
        `Timed out waiting for renderer on ${rendererUrl} after ${rendererStartupTimeoutMs}ms (last error: ${lastError}).`,
      );
    }

    const distPath = path.join(appDir, "..", "dist");
    const sirvHandler = sirv(distPath, {
      single: true,
      dev: false,
    });

    productionHttpServer = http.createServer((request, response) => {
      if (request.url?.startsWith("/api")) {
        const proxyUrl = new URL(
          request.url,
          `http://127.0.0.1:${apiServerPort}`,
        );
        const proxyReq = http.request(
          proxyUrl,
          {
            method: request.method,
            headers: request.headers,
          },
          (proxyRes) => {
            response.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(response, { end: true });
          },
        );
        proxyReq.on("error", (error) => {
          console.error("API proxy error:", error);
          response.statusCode = 502;
          response.end("API proxy error");
        });
        request.pipe(proxyReq, { end: true });
        return;
      }

      sirvHandler(request, response, () => {
        response.statusCode = 404;
        response.end("Not found");
      });
    });

    await new Promise((resolve, reject) => {
      productionHttpServer.once("error", reject);
      productionHttpServer.listen(internalRendererPort, "127.0.0.1", resolve);
    });

    rendererUrl = `http://127.0.0.1:${internalRendererPort}`;
  }

  async function stop() {
    if (viteDevProcess) {
      stopChildProcess(viteDevProcess);
      viteDevProcess = null;
    }

    if (productionHttpServer) {
      await new Promise((resolve) => {
        productionHttpServer.close(() => resolve(undefined));
      });
      productionHttpServer = null;
    }
  }

  return {
    getApiServerPort: () => apiServerPort,
    getApiSessionToken: () => apiSessionToken,
    getInternalRendererPort: () => internalRendererPort,
    getUrl: () => rendererUrl,
    start,
    stop,
  };
}
