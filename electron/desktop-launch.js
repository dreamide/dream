// The desktop's launch and quit, in order. main.js calls each step at its
// point in Electron's lifecycle; windows, menus and shortcuts stay there.
//
//   prepare        at import, before any writer starts: the workspace
//                  database (moved out of the state database once, or left
//                  sharing its writer), the workspace lock (a second desktop
//                  on it ends its launch), the save queue, the host mode and
//                  the home host.
//   start          once Electron is ready: the ports, then the renderer
//                  server's start() (renderer-server.js: the host and the
//                  renderer together), then remote access once the host
//                  listens.
//   readInstallId  after start: this install's id, saved when new.
//   quit           on before-quit: the host, the connections, the renderer
//                  server, the save queue's flush, the database, the
//                  workspace lock. The first failure ends it.
//
// Electron's parts and every factory with an effect are passed in, so the
// order runs under test without Electron (desktop-launch.test.js).
import { resolveDesktopHostMode } from "./desktop-host-mode.js";
import { StateLockedError } from "./host/state-lock.js";

/** @typedef {import("./host/home-host.js").HomeHost} HomeHost */

const parsePort = (value) => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

/**
 * @param {{
 *   electron: { app: { isPackaged: boolean }, dialog: { showErrorBox: (title: string, content: string) => void } },
 *   exit: (code: number) => void,
 *   env: NodeJS.ProcessEnv,
 *   appName: string,
 *   version: string | null,
 *   isDevelopment: boolean,
 *   paths: { appDir: string, clientDirectory: string, dataDirectory: string },
 *   getConnections: () => { getEndpoint: (hostId: string) => unknown, disconnectAll: () => Promise<unknown> },
 *   persistence: {
 *     configureHostDataDirectory: (dataDirectory: string) => void,
 *     resolveStateDatabasePath: () => string,
 *     prepareWorkspaceDatabase: (options: { stateDatabasePath: string }) => { workspaceDatabasePath: string, migrated: boolean, backupPath: string | null },
 *     acquireStateLock: (databasePath: string, options: { kind: string }) => () => void,
 *     createStateSaveQueue: (options: { databasePath: string }) => any,
 *     readOrCreatePersistedInstallId: (options: { databasePath: string }) => { installId: string, created: boolean },
 *     installIdConfigValue: (installId: string) => unknown,
 *     closePersistedStateDatabase: () => void,
 *   },
 *   hosts: {
 *     createHost: (options: object) => HomeHost,
 *     createHomeHostAttachment: (options: object) => HomeHost,
 *     withInProcessFallback: (options: object) => HomeHost,
 *   },
 *   renderer: {
 *     getPort: (options: object) => Promise<number>,
 *     createRendererServerManager: (options: object) => any,
 *   },
 * }} deps
 *   `env`: DREAM_HOST_MODE, ELECTRON_API_PORT, ELECTRON_INTERNAL_PORT,
 *   ELECTRON_RENDERER_URL and VITE_READY_TIMEOUT_MS are read from it.
 *   `getConnections`: the desktop's host connections, created after the
 *   home host; the host reaches SSH hosts through them, and quit
 *   disconnects them.
 */
export function createDesktopLaunch({
  electron: { app, dialog },
  exit,
  env,
  appName,
  version,
  isDevelopment,
  paths,
  getConnections,
  persistence,
  hosts,
  renderer,
}) {
  /** @type {null | { workspaceDatabasePath: string, releaseWorkspaceLock: () => void, saveQueue: any, host: HomeHost }} */
  let prepared = null;
  let rendererServer = null;

  const requirePrepared = () => {
    if (!prepared) throw new Error("The desktop launch was not prepared.");
    return prepared;
  };

  /**
   * The workspace database, its lock, its save queue and the home host.
   * Synchronous: it runs at import, before either writer starts. A
   * workspace another desktop holds shows a dialog and exits with 1 (and
   * answers null should `exit` return).
   */
  const prepare = () => {
    // The desktop's workspace and its local host's catalog are separate
    // files, each with its own writer (workspace-database.js): the
    // desktop's save queue writes the workspace, the host its catalog. An
    // existing workspace moves out of the state database once, from a
    // backed-up copy.
    persistence.configureHostDataDirectory(paths.dataDirectory);
    const stateDatabasePath = persistence.resolveStateDatabasePath();
    let workspaceDatabasePath = stateDatabasePath;
    let workspaceSeparate = false;
    try {
      const moved = persistence.prepareWorkspaceDatabase({ stateDatabasePath });
      workspaceDatabasePath = moved.workspaceDatabasePath;
      workspaceSeparate = true;
      if (moved.migrated) {
        console.log(
          `Moved the workspace to ${moved.workspaceDatabasePath} (backup: ${moved.backupPath}).`,
        );
      }
    } catch (error) {
      // The workspace stays where it was, with the one shared writer it
      // had: nothing is lost, and the move is tried again at the next start.
      console.error("Could not move the workspace to its own database:", error);
    }

    // One desktop per workspace: two would be two writers of one file. A
    // host in this process on the shared database takes the state lock
    // instead.
    let releaseWorkspaceLock = () => {};
    if (workspaceSeparate) {
      try {
        releaseWorkspaceLock = persistence.acquireStateLock(
          workspaceDatabasePath,
          { kind: "desktop" },
        );
      } catch (error) {
        if (!(error instanceof StateLockedError)) throw error;
        dialog.showErrorBox(
          "Dream is already running",
          `Another Dream window (process ${error.holder?.pid ?? "unknown"}) is using this workspace. Switch to it, or quit it first.`,
        );
        exit(1);
        return null;
      }
    }

    // The workspace's reads and writes stay off the main thread. The queue
    // runs them in order: workspace changes, config values and the
    // workspace load a reloaded window makes. Created here, once the file
    // and its lock are settled and before the host that may share it; its
    // worker starts at the first read or write.
    const saveQueue = persistence.createStateSaveQueue({
      databasePath: workspaceDatabasePath,
    });

    // The home host: the host running on this desktop's database (whoever
    // started it) or one the desktop starts, or inside this process. All
    // of them use this desktop's identity and catalog.
    const resolvedHostMode = resolveDesktopHostMode({
      envMode: env.DREAM_HOST_MODE?.trim() || "",
      workspaceSeparate,
    });
    const hostOptions = {
      // The browser client paired devices load: this app's renderer build.
      clientDirectory: paths.clientDirectory,
      dataDirectory: paths.dataDirectory,
      diagnosticsEnabled: !app.isPackaged,
      // Requests for SSH-host projects go through the local API to the
      // host's forwarded port (api/host-proxy-routes.js).
      resolveRemoteHost: (hostId) => getConnections().getEndpoint(hostId),
      version,
    };
    const createInProcessHost = () =>
      hosts.createHost({
        ...hostOptions,
        kind: "desktop",
        // Only while the workspace could not move out: then the host's
        // writes share the workspace's queue, one writer for the one file.
        ...(workspaceSeparate ? {} : { getStateWriter: () => saveQueue }),
      });
    const host =
      resolvedHostMode.mode === "detached"
        ? // A host that cannot start in its own process, with nothing else
          // on the data, leaves the window working with a host in this one.
          hosts.withInProcessFallback({
            attached: hosts.createHomeHostAttachment({
              ...hostOptions,
              stateDatabasePath,
            }),
            createInProcess: createInProcessHost,
            fallBack: true,
            stateDatabasePath,
          })
        : createInProcessHost();

    prepared = { host, releaseWorkspaceLock, saveQueue, workspaceDatabasePath };
    return {
      host,
      /** The host mode now: a detached host that could not start fell back. */
      hostMode: () => host.mode,
      saveQueue,
      workspaceDatabasePath,
    };
  };

  const createStartupRendererServer = async (onRendererOutput) => {
    const { host } = requirePrepared();
    const rendererUrlFromEnv = env.ELECTRON_RENDERER_URL?.trim();
    const configuredApiServerPort = parsePort(env.ELECTRON_API_PORT);
    const configuredInternalRendererPort = parsePort(
      env.ELECTRON_INTERNAL_PORT,
    );
    const apiServerPort =
      configuredApiServerPort ??
      (await renderer.getPort({
        exclude:
          configuredInternalRendererPort === null
            ? undefined
            : [configuredInternalRendererPort],
        host: "127.0.0.1",
        reserve: true,
      }));
    const internalRendererPort =
      configuredInternalRendererPort ??
      (await renderer.getPort({
        exclude: [apiServerPort],
        host: "127.0.0.1",
        reserve: true,
      }));

    if (!rendererUrlFromEnv && apiServerPort === internalRendererPort) {
      throw new Error(
        `Renderer and API ports must be different. Both resolved to ${apiServerPort}.`,
      );
    }

    console.log(
      `Starting ${appName} with renderer port ${internalRendererPort} and API port ${apiServerPort}.`,
    );

    return renderer.createRendererServerManager({
      apiServerPort,
      appDir: paths.appDir,
      developmentRendererUrl:
        rendererUrlFromEnv || `http://127.0.0.1:${internalRendererPort}`,
      internalRendererPort,
      isDevelopment,
      rendererProbeIntervalMs: 300,
      rendererStartupTimeoutMs: Number(env.VITE_READY_TIMEOUT_MS ?? 45000),
      rendererUrlFromEnv,
      startApi: ({ apiToken, port }) => host.listen({ apiToken, port }),
      onRendererOutput,
    });
  };

  /**
   * Picks the ports and starts the renderer server (the home host and the
   * renderer together), resolving when the window can load. Remote access
   * starts once the host listens; `hostListening` says when it does, or
   * why it did not.
   * @param {{ onRendererOutput?: (text: string) => void }} [options]
   */
  const start = async ({ onRendererOutput } = {}) => {
    const { host } = requirePrepared();
    rendererServer = await createStartupRendererServer(onRendererOutput);
    // The host starts beside the renderer; in production the window loads
    // while it does (renderer-server.js says what the window waits on).
    await rendererServer.start();
    const hostListening = rendererServer.whenHostListening();
    // Remote access as the user left it (Settings > Connections), once the
    // host listens. Never holds the window up: its setup can wait on
    // Tailscale.
    hostListening.then(
      () =>
        host
          .startRemoteAccess()
          .catch((error) =>
            console.warn("Remote access did not start:", error),
          ),
      () => {},
    );
    return { hostListening, rendererServer };
  };

  /** This install's id, created and saved the first time; null if unread. */
  const readInstallId = () => {
    const { saveQueue, workspaceDatabasePath } = requirePrepared();
    let installId = null;
    try {
      const persisted = persistence.readOrCreatePersistedInstallId({
        databasePath: workspaceDatabasePath,
      });
      installId = persisted.installId;
      if (persisted.created) {
        saveQueue
          .write("config", persistence.installIdConfigValue(installId))
          .catch((error) => {
            console.error("Failed to save install ID:", error);
          });
      }
    } catch (error) {
      console.error("Failed to initialize install ID:", error);
    }
    return installId;
  };

  /**
   * The teardown, in order: the host, the connections, the renderer
   * server, every queued workspace write, the database, then the workspace
   * lock. A step that fails rejects and skips the rest.
   */
  const quit = async () => {
    const { host, releaseWorkspaceLock, saveQueue } = requirePrepared();
    await host.close();
    await getConnections().disconnectAll();
    await rendererServer?.stop();
    await saveQueue.flushAndClose();
    persistence.closePersistedStateDatabase();
    releaseWorkspaceLock();
  };

  return {
    prepare,
    start,
    readInstallId,
    quit,
    /** The renderer server once start has created it, else null. */
    rendererServer: () => rendererServer,
  };
}
