// The desktop's home host in another process: the host running on the
// desktop's database, whoever started it, or else one the desktop starts
// (`dream-host serve` with Electron's binary as Node). The desktop keeps its
// workspace, SSH connections and browser; the host process keeps all
// execution. The desktop's API port is an edge listener that verifies the
// host is this desktop's (its database owner and identity) and forwards to
// it.
//
// The desktop manages only its own process: a host a desktop started
// (`--owner desktop`) is stopped when the desktop quits, and replaced when
// it runs another version; a host the user started is attached to and left
// running.

import { existsSync } from "node:fs";
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
import { hostOptionFlags } from "./host/options.js";
import { HOST_PROTOCOL_VERSION, hostProtocolProblem } from "./host/protocol.js";
import {
  getHostHome,
  getRunDirectory,
  readHostRecord,
} from "./host/run-directory.js";
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

/** The host home of the desktop's own host, beside its database. */
export const childHostHome = (stateDatabasePath) => `${stateDatabasePath}.host`;

/**
 * The host running on `stateDatabasePath`, found from the database alone:
 * its state lock's record names its run directory (`dream-host serve`
 * writes it). A host from before that record named it is looked for where
 * hosts used to run: the default host home and the desktop's own.
 *
 * Resolves with null when no host holds the database; with
 * `{ unreachable: true, holder }` when one does that cannot be reached here
 * (the host inside another desktop's process); otherwise with where it runs
 * and who started it.
 * @param {string} stateDatabasePath
 * @param {{ env?: NodeJS.ProcessEnv, probe?: typeof probeDaemon }} [options]
 */
export async function findRunningHost(
  stateDatabasePath,
  { env = process.env, probe = probeDaemon } = {},
) {
  if (!isStateLockHeld(stateDatabasePath)) return null;
  const holder = readStateLockRecord(stateDatabasePath);
  const candidates = [
    holder?.runDirectory,
    getRunDirectory(childHostHome(stateDatabasePath), HOST_PROTOCOL_VERSION),
    getRunDirectory(path.resolve(getHostHome(env)), HOST_PROTOCOL_VERSION),
  ].filter(
    (candidate, index, all) => candidate && all.indexOf(candidate) === index,
  );
  for (const runDirectory of candidates) {
    const record = await probe(runDirectory);
    if (!record || (holder && record.pid !== holder.pid)) continue;
    const owner =
      record.owner ??
      holder?.owner ??
      (holder?.kind === "desktop" ? "desktop" : "user");
    return { owner, record, runDirectory };
  }
  return { holder, unreachable: true };
}

/**
 * The edge to a home host in another process. Only the owner of this
 * desktop's database and identity may be its home host.
 * @param {{
 *   dataDirectory: string,
 *   stateDatabasePath: string,
 *   resolveRemoteHost: (hostId: string) => unknown,
 *   getRunDirectory: () => string | null,
 *   start: () => Promise<void>,
 *   stop?: () => Promise<void>,
 *   shutdownMessage: string,
 *   unavailableMessage: string,
 * }} options
 *   `getRunDirectory`: where the host's run record is now (it can change
 *   when `start` finds another host). `start`: brings the host up, or
 *   finds it, before the edge listens. `stop`: run when the edge closes.
 */
function createHostAttachment({
  dataDirectory,
  stateDatabasePath,
  resolveRemoteHost,
  getRunDirectory: currentRunDirectory,
  start,
  stop = async () => {},
  shutdownMessage,
  unavailableMessage,
}) {
  let identity = null;
  let verified = null;
  let checking = null;
  let server = null;

  const verify = async () => {
    const runDirectory = currentRunDirectory();
    // Read the record every time: a restart can change both port and token.
    const record = runDirectory ? readHostRecord(runDirectory) : null;
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
          "The host does not own this desktop's state database. Check its --data-dir and --database options.",
        );
      }
      if (holder.pid !== running.pid) {
        throw new Error(
          "The host uses a different state database. Start it with this desktop's --data-dir and --database.",
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

/**
 * The desktop's home host: the one running on its database, whoever started
 * it, or else one it starts. Stops at close only a host a desktop started.
 * @param {{
 *   dataDirectory: string,
 *   stateDatabasePath: string,
 *   resolveRemoteHost: (hostId: string) => unknown,
 *   version: string | null,
 *   clientDirectory: string,
 *   diagnosticsEnabled?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (message: string) => void,
 *   ensure?: typeof ensureDaemon,
 *   find?: typeof findRunningHost,
 *   stopDaemon?: typeof stopRunningDaemon,
 * }} options
 */
export function createHomeHostAttachment({
  dataDirectory,
  stateDatabasePath,
  resolveRemoteHost,
  version,
  clientDirectory,
  diagnosticsEnabled = false,
  env = process.env,
  log = (message) => console.log(`[host] ${message}`),
  ensure = ensureDaemon,
  find = findRunningHost,
  stopDaemon = stopRunningDaemon,
}) {
  const home = childHostHome(stateDatabasePath);
  /** @type {{ runDirectory: string, owned: boolean, version: string | null } | null} */
  let current = null;

  /** Starts the desktop's own host. */
  const startOwn = async () => {
    const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
    let started;
    try {
      started = await ensure({
        // The window's own binary runs the host as Node.
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        flags: hostOptionFlags({
          clientDir: clientDirectory,
          database: stateDatabasePath,
          dataDir: dataDirectory,
          diagnostics: diagnosticsEnabled,
          owner: "desktop",
        }),
        home,
        runDirectory,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(error?.log ? `${message} See ${error.log}.` : message);
    }
    current = {
      owned: true,
      runDirectory,
      version: started.record.version ?? null,
    };
    log(
      `${started.reused ? "Attached to" : "Started"} this desktop's host ${started.record.pid} on 127.0.0.1:${started.record.port}; its log is ${path.join(runDirectory, "host.log")}.`,
    );
  };

  const start = async () => {
    const found = await find(stateDatabasePath, { env });
    if (found?.unreachable) {
      const who = found.holder
        ? `${found.holder.kind ?? "process"} ${found.holder.pid}`
        : "another process";
      throw new Error(
        `Another Dream host (${who}) is using this desktop's data and cannot be reached from here. Quit it, or run it with \`dream-host serve\` so this desktop can attach to it.`,
      );
    }
    if (found?.owner === "desktop") {
      // A desktop's own host, left by one that did not stop it (a crash):
      // still the desktop's to manage, and it must run this desktop's code.
      if (version && found.record.version !== version) {
        log(
          `Replacing the host left by Dream ${found.record.version ?? "(unknown)"}.`,
        );
        await stopDaemon(found.runDirectory);
        await startOwn();
        return;
      }
      current = {
        owned: true,
        runDirectory: found.runDirectory,
        version: found.record.version ?? null,
      };
      log(`Attached to this desktop's host ${found.record.pid}.`);
      return;
    }
    if (found) {
      current = {
        owned: false,
        runDirectory: found.runDirectory,
        version: found.record.version ?? null,
      };
      log(
        `Attached to the host ${found.record.pid} started with dream-host; it keeps running when Dream quits.`,
      );
      return;
    }
    await startOwn();
  };

  const attachment = createHostAttachment({
    dataDirectory,
    getRunDirectory: () => current?.runDirectory ?? null,
    resolveRemoteHost,
    shutdownMessage:
      "Restart the host from Settings, or quit Dream to stop the host it started.",
    async start() {
      await start();
    },
    async stop() {
      if (!current?.owned) return;
      const result = await stopDaemon(current.runDirectory);
      if (result.running) log(`The host ${result.pid} did not stop.`);
    },
    stateDatabasePath,
    unavailableMessage:
      "This desktop's host is not running. Restart the host from Settings, or restart Dream.",
  });

  return {
    ...attachment,

    /** Whether this desktop started the host (and so stops it). */
    describe: () => ({
      owned: current?.owned ?? false,
      runDirectory: current?.runDirectory ?? null,
      version: current?.version ?? null,
    }),

    /**
     * Restarts the host this desktop started; refused for one it did not.
     * Clients reconnect on their own once it answers again.
     */
    async restart() {
      if (!current?.owned) {
        throw new Error(
          "This host was started with dream-host; restart it where it runs.",
        );
      }
      await stopDaemon(current.runDirectory);
      await startOwn();
    },
  };
}

/**
 * The desktop's home host in another process, or a host in this process
 * when it cannot start and nothing else holds the data. `mode` says which
 * serves now: `detached`, then `in-process` after a fallback.
 * @param {{
 *   attached: ReturnType<typeof createHomeHostAttachment>,
 *   createInProcess: () => any,
 *   fallBack: boolean,
 *   stateDatabasePath: string,
 *   isHeld?: (stateDatabasePath: string) => boolean,
 *   log?: (message: string, error?: unknown) => void,
 * }} options
 *   `fallBack`: false when the mode was asked for explicitly; a failure is
 *   then the launch's failure.
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
  let mode = "detached";
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
    describe: () =>
      mode === "in-process"
        ? { owned: true, runDirectory: null, version: null }
        : attached.describe(),
    restart: () =>
      mode === "in-process"
        ? Promise.reject(
            new Error(
              "The host runs inside Dream; restart Dream to restart it.",
            ),
          )
        : attached.restart(),
    close: () => active.close(),
  };
}
