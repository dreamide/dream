// The desktop's home host when it runs in another process: an installed host
// service, or the desktop's own child host. The desktop keeps its workspace,
// SSH connections and browser; the host process keeps all execution. The
// desktop's API port is an edge listener that verifies the host is this
// desktop's (its database owner and identity) and forwards to it.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { serveApp } from "./api/app.js";
import { registerBrowserToolCallRoutes } from "./api/browser-tool-call-routes.js";
import {
  isProxiedHostSocketPath,
  registerEndpointProxyRoutes,
  registerHostProxyRoutes,
} from "./api/host-proxy-routes.js";
import { HOST_SOCKET_PATH } from "./api/host-socket-routes.js";
import { API_SESSION_TOKEN_HEADER } from "./api/shared/session-token.js";
import { ensureDaemon, probeDaemon, stopRunningDaemon } from "./host/daemon.js";
import { HOST_IDENTITY_FILE, loadHostIdentity } from "./host/identity.js";
import { HOST_PROTOCOL_VERSION, hostProtocolProblem } from "./host/protocol.js";
import { getRunDirectory, readHostRecord } from "./host/run-directory.js";
import {
  createServiceManager,
  readInstalledServiceName,
  readServiceRecord,
} from "./host/service/service.js";
import { isStateLockHeld, readStateLockRecord } from "./host/state-lock.js";

/** A desktop edge with workspace/UI services, but no local execution owner. */
export function createRemoteOnlyHost({
  resolveRemoteHost,
  resolveProviderHost,
}) {
  let server = null;
  return {
    processSessions: {
      hasActiveSessions: () => false,
      stopAllProcesses: async () => {},
    },
    startRemoteAccess: async () => {},
    async listen({ apiToken, port }) {
      const app = new Hono();
      app.use("/api/*", async (c, next) => {
        if (
          !isProxiedHostSocketPath(c.req.path) &&
          c.req.header(API_SESSION_TOKEN_HEADER) !== apiToken
        )
          return c.text("Unauthorized", 401);
        return next();
      });
      registerBrowserToolCallRoutes(app);
      registerHostProxyRoutes(app, {
        resolveHost: resolveRemoteHost,
        upgradeWebSocket,
      });
      // Global provider settings belong to the first connected remote host.
      registerEndpointProxyRoutes(app, {
        path: "/api/provider-*",
        socketPath: "/__no_socket__",
        targetPath: (c) => c.req.path,
        resolveEndpoint: resolveProviderHost,
      });
      registerEndpointProxyRoutes(app, {
        path: "/api/cli-*",
        socketPath: "/__no_cli_socket__",
        targetPath: (c) => c.req.path,
        resolveEndpoint: resolveProviderHost,
      });
      app.all("/api/*", (c) =>
        c.text(
          "This desktop has no local execution host. Select a remote connection.",
          503,
        ),
      );
      server = await serveApp(app, { hostname: "127.0.0.1", port });
      return server.port;
    },
    async close() {
      await server?.close();
      server = null;
    },
  };
}

/**
 * The edge to a home host in another process. Only the owner of this
 * desktop's database and identity may be its home host.
 * @param {{
 *   home: string,
 *   dataDirectory: string,
 *   stateDatabasePath: string,
 *   resolveRemoteHost: (hostId: string) => unknown,
 *   start: () => Promise<void>,
 *   stop?: () => Promise<void>,
 *   shutdownMessage: string,
 *   unavailableMessage: string,
 * }} options
 *   `start`: brings the host up (or confirms it is up) before the edge
 *   listens. `stop`: run when the edge closes, for a host this desktop
 *   owns. `shutdownMessage`: the answer to a client asking the host to shut
 *   down, which is this desktop's or the operator's decision.
 */
function createHostAttachment({
  home,
  dataDirectory,
  stateDatabasePath,
  resolveRemoteHost,
  start,
  stop = async () => {},
  shutdownMessage,
  unavailableMessage,
}) {
  const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
  let identity = null;
  let verified = null;
  let checking = null;
  let server = null;

  const verify = async () => {
    // Read the record every time: a restart can change both port and token.
    const record = readHostRecord(runDirectory);
    if (!record) throw new Error(unavailableMessage);
    const key = JSON.stringify(record);
    if (verified?.key === key) return verified.endpoint;
    if (checking?.key === key) return checking.promise;
    const promise = (async () => {
      const running = await probeDaemon(runDirectory);
      if (!running || JSON.stringify(running) !== key) {
        throw new Error(unavailableMessage);
      }
      const holder = readStateLockRecord(stateDatabasePath);
      if (!holder) {
        throw new Error(
          "The host does not own this desktop's state database. Check its --data-dir and DREAM_DB_PATH configuration.",
        );
      }
      if (holder.pid !== running.pid) {
        throw new Error(
          "The host uses a different state database. Install it with this desktop's data directory and DREAM_DB_PATH before attaching.",
        );
      }
      if (!existsSync(path.join(dataDirectory, HOST_IDENTITY_FILE))) {
        throw new Error(
          "The desktop's host identity is missing. Attach to the host using the original desktop data directory.",
        );
      }
      // Pin before awaiting the descriptor: concurrent requests during a
      // restart must all compare against the same local identity.
      identity ??= loadHostIdentity(dataDirectory);
      const expected = identity;
      const endpoint = {
        baseUrl: `http://127.0.0.1:${running.port}`,
        token: running.token,
      };
      const response = await fetch(`${endpoint.baseUrl}/api/host-info`, {
        headers: { [API_SESSION_TOKEN_HEADER]: endpoint.token },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error("The host refused attachment.");
      const info = await response.json();
      const problem = hostProtocolProblem(info.hostProtocolVersion);
      if (problem) throw new Error(problem);
      if (!info.capabilities?.includes("terminal-discovery")) {
        throw new Error(
          "Update and restart the host before attaching this desktop; it does not support terminal discovery.",
        );
      }
      if (
        info.pid !== running.pid ||
        info.hostId !== expected.hostId ||
        info.fingerprint !== expected.fingerprint ||
        info.publicKey !== expected.publicKey
      ) {
        throw new Error(
          "The host is a different host. Restore the original host data and identity before attaching.",
        );
      }
      identity = expected;
      verified = { endpoint, key };
      return endpoint;
    })();
    checking = { key, promise };
    try {
      return await promise;
    } finally {
      if (checking?.promise === promise) checking = null;
    }
  };

  return {
    // The desktop owns no host processes to stop on unload.
    processSessions: {
      hasActiveSessions: () => false,
      stopAllProcesses: async () => {},
    },
    // The host process starts its own remote access.
    startRemoteAccess: async () => {},
    async listen({ apiToken, port }) {
      if (server) throw new Error("The desktop edge is already listening.");
      await start();
      await verify();
      const app = new Hono();
      app.onError((error, c) => c.text(error.message, 503));
      app.use("/api/*", async (c, next) => {
        if (
          c.req.path !== HOST_SOCKET_PATH &&
          !isProxiedHostSocketPath(c.req.path) &&
          c.req.header(API_SESSION_TOKEN_HEADER) !== apiToken
        ) {
          return c.text("Unauthorized", 401);
        }
        return next();
      });
      // These calls must execute in the process that owns the browser.
      registerBrowserToolCallRoutes(app);
      registerHostProxyRoutes(app, {
        resolveHost: resolveRemoteHost,
        upgradeWebSocket,
      });
      app.post("/api/host/shutdown", (c) => c.text(shutdownMessage, 409));
      registerEndpointProxyRoutes(app, {
        path: "/api/*",
        resolveEndpoint: verify,
        socketPath: HOST_SOCKET_PATH,
        targetPath: (c) => c.req.path,
        upgradeWebSocket,
      });
      server = await serveApp(app, { hostname: "127.0.0.1", port });
      return server.port;
    },
    async close() {
      const closing = server;
      server = null;
      await closing?.close();
      await stop();
    },
  };
}

/** Attaches to the installed host service of `home`. */
export function createServiceHostAttachment({
  home,
  dataDirectory,
  stateDatabasePath,
  resolveRemoteHost,
  env = process.env,
  createManager = createServiceManager,
}) {
  const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
  return createHostAttachment({
    dataDirectory,
    home,
    resolveRemoteHost,
    shutdownMessage: "Use `dream-host service stop` to stop the service.",
    async start() {
      const name = readInstalledServiceName(home);
      if (!name)
        throw new Error(
          "Service mode needs an installed host service. Run `dream-host service install` with the desktop's data directory first.",
        );
      const manager = createManager({ env, home, name });
      if (!manager.isInstalled() || !manager.servesHome(home)) {
        throw new Error("The installed service does not serve this host home.");
      }
      if (await probeDaemon(runDirectory)) return;
      await manager.start();
      const deadline = Date.now() + 20_000;
      while (!(await probeDaemon(runDirectory)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    stateDatabasePath,
    unavailableMessage:
      "The host service is unavailable; run `dream-host service status`.",
  });
}

/**
 * Whether an installed host service of `home` runs the host of this
 * desktop's data: its data directory and state database. Never throws.
 */
export function serviceServesDesktop({
  home,
  dataDirectory,
  stateDatabasePath,
  env = process.env,
  createManager = createServiceManager,
}) {
  try {
    const record = readServiceRecord(home);
    const launch = record?.launch;
    if (!launch || typeof record.name !== "string") return false;
    const index = launch.args.indexOf("--data-dir");
    if (index < 0) return false;
    const served = launch.args[index + 1];
    const database =
      launch.environment?.DREAM_DB_PATH || path.join(served, "dream.db");
    if (realpathSync(served) !== realpathSync(dataDirectory)) return false;
    if (path.resolve(database) !== path.resolve(stateDatabasePath)) {
      return false;
    }
    const manager = createManager({ env, home, name: record.name });
    return manager.isInstalled() && manager.servesHome(home);
  } catch {
    return false;
  }
}

/** The host home of the desktop's own child host, beside its database. */
export const childHostHome = (stateDatabasePath) => `${stateDatabasePath}.host`;

/**
 * Starts (or reuses) the desktop's own child host and attaches to it.
 * The child is `dream-host serve` on the desktop's data, run by Electron's
 * binary as plain Node and detached, so it can outlive the window when the
 * user keeps it running (`keepRunning()` at close).
 * @param {{
 *   dataDirectory: string,
 *   stateDatabasePath: string,
 *   resolveRemoteHost: (hostId: string) => unknown,
 *   version: string | null,
 *   clientDirectory: string,
 *   diagnosticsEnabled?: boolean,
 *   keepRunning: () => boolean,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (message: string) => void,
 *   ensure?: typeof ensureDaemon,
 *   probe?: typeof probeDaemon,
 *   stopDaemon?: typeof stopRunningDaemon,
 * }} options
 */
export function createChildHostAttachment({
  dataDirectory,
  stateDatabasePath,
  resolveRemoteHost,
  version,
  clientDirectory,
  diagnosticsEnabled = false,
  keepRunning,
  env = process.env,
  log = (message) => console.log(`[host] ${message}`),
  ensure = ensureDaemon,
  probe = probeDaemon,
  stopDaemon = stopRunningDaemon,
}) {
  const home = childHostHome(stateDatabasePath);
  const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
  return createHostAttachment({
    dataDirectory,
    home,
    resolveRemoteHost,
    shutdownMessage: "Quit Dream to stop its host.",
    async start() {
      // A host kept running by an older or newer app is replaced: it is
      // this desktop's own, and must run this desktop's code.
      const running = await probe(runDirectory);
      if (running && version && running.version !== version) {
        log(
          `Replacing the host kept running by Dream ${running.version ?? "(unknown)"}.`,
        );
        await stopDaemon(runDirectory);
      }
      let started;
      try {
        started = await ensure({
          env: {
            ...env,
            // The window's own binary runs the host as Node.
            ELECTRON_RUN_AS_NODE: "1",
            // Absolute, so a relative setting cannot resolve elsewhere there.
            DREAM_DB_PATH: stateDatabasePath,
          },
          home,
          runDirectory,
          values: {
            "client-dir": clientDirectory,
            "data-dir": dataDirectory,
            diagnostics: diagnosticsEnabled,
            owner: "desktop",
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(error?.log ? `${message} See ${error.log}.` : message);
      }
      log(
        `${started.reused ? "Attached to" : "Started"} host ${started.record.pid} on 127.0.0.1:${started.record.port}; its log is ${path.join(runDirectory, "host.log")}.`,
      );
    },
    async stop() {
      if (keepRunning()) {
        log("Leaving the host running.");
        return;
      }
      const result = await stopDaemon(runDirectory);
      if (result.running) log(`The host ${result.pid} did not stop.`);
    },
    stateDatabasePath,
    unavailableMessage:
      "The desktop's host is not running. Restart Dream to start it again.",
  });
}

/**
 * The desktop's child host, or a host in this process when the child
 * cannot start and nothing else holds the data. `mode` says which serves
 * now: `child`, then `in-process` after a fallback.
 * @param {{
 *   attached: ReturnType<typeof createChildHostAttachment>,
 *   createInProcess: () => any,
 *   fallBack: boolean,
 *   stateDatabasePath: string,
 *   isHeld?: (stateDatabasePath: string) => boolean,
 *   log?: (message: string, error?: unknown) => void,
 * }} options
 *   `fallBack`: false when the child host was asked for explicitly; its
 *   failure is then the launch's failure.
 */
export function withInProcessFallback({
  attached,
  createInProcess,
  fallBack,
  stateDatabasePath,
  isHeld = isStateLockHeld,
  log = (message, error) => console.error(`[host] ${message}`, error ?? ""),
}) {
  let active = attached;
  let mode = "child";
  return {
    get mode() {
      return mode;
    },
    processSessions: {
      hasActiveSessions: () => active.processSessions.hasActiveSessions(),
      stopAllProcesses: () => active.processSessions.stopAllProcesses(),
    },
    startRemoteAccess: () => active.startRemoteAccess(),
    async listen(options) {
      try {
        return await attached.listen(options);
      } catch (error) {
        if (!fallBack) throw error;
        // Whatever started is stopped, so its lock is free for this one.
        await attached.close().catch(() => {});
        if (isHeld(stateDatabasePath)) throw error;
        log(
          "The host could not start in its own process; running it in this one.",
          error,
        );
        active = createInProcess();
        mode = "in-process";
        return active.listen(options);
      }
    },
    close: () => active.close(),
  };
}
