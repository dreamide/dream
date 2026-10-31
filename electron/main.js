import "./load-env.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  nativeTheme,
  safeStorage,
  shell,
  WebContentsView,
} from "electron";
import getPort from "get-port";
import { setBrowserBridge } from "./api/browser-bridge.js";
import {
  configureApplicationMenu,
  toggleWebContentsDevToolsDetached,
} from "./app-menu.js";
import {
  captureAppScreenshot,
  isAppScreenshotShortcut,
} from "./app-screenshot.js";
import { createBrowserAgentBridge } from "./browser-agent-bridge.js";
import { createBrowserSessionManager } from "./browser-sessions.js";
import { createDesktopHostConnections } from "./connections/desktop-connections.js";
import { createDeviceCredentials } from "./connections/device-credentials.js";
import { createHttpsRoutes } from "./connections/https-route.js";
import {
  createDesktopHandlers,
  isHttpUrl,
  registerDesktopHandlers,
} from "./desktop-handlers.js";
import {
  createHomeHostAttachment,
  withInProcessFallback,
} from "./desktop-host.js";
import { resolveDesktopHostMode } from "./desktop-host-mode.js";
import { createDevLogger, publishDevSession } from "./dev-inspection.js";
import { detectAvailableEditors, openProjectInEditor } from "./editors.js";
import { getHelloUrl } from "./hello.js";
import { configureHostDataDirectory } from "./host/host-paths.js";
import { createHost } from "./host/index.js";
import { acquireStateLock, StateLockedError } from "./host/state-lock.js";
import {
  closePersistedStateDatabase,
  installIdConfigValue,
  loadPersistedThemePreference,
  readOrCreatePersistedInstallId,
  resolveStateDatabasePath,
  themePreferenceConfigValue,
} from "./persisted-state.js";
import { createRendererServerManager } from "./renderer-server.js";
import {
  createRendererUnloadGuard,
  getReloadShortcutOptions,
} from "./renderer-unload-guard.js";
import {
  DESKTOP_SYNC_CHANNELS,
  desktopChannel,
} from "./shared/desktop-channels.js";
import { createSshPromptBroker } from "./ssh/prompt-broker.js";
import { readSshConfigHosts } from "./ssh/ssh-config-hosts.js";
import { createStateSaveQueue } from "./state-save-queue.js";
import { createThemeStore } from "./theme-store.js";
import { initializeAutoUpdater } from "./updater.js";
import { prepareWorkspaceDatabase } from "./workspace-database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appIconFileName = process.platform === "win32" ? "icon.ico" : "icon.png";
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, appIconFileName)
  : path.join(__dirname, "..", "public", appIconFileName);

const isDevelopment = process.env.NODE_ENV === "development";
const devInspectionEnabled = isDevelopment && !app.isPackaged;
let devLogger = null;
const devToolsPort = Number(process.env.DREAM_DEVTOOLS_PORT);
if (
  devInspectionEnabled &&
  Number.isInteger(devToolsPort) &&
  devToolsPort > 0 &&
  devToolsPort <= 65535
) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(devToolsPort));
}

// Dream's version. Unpackaged, `app.getVersion()` can answer Electron's own
// version, which names no Dream release (and so no host runtime to install).
const readDreamVersion = () => {
  if (app.isPackaged) return app.getVersion();
  try {
    return JSON.parse(
      readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ).version;
  } catch {
    return app.getVersion();
  }
};
const dreamVersion = readDreamVersion();
// A host mode named in the environment (desktop-host-mode.js); `desktop` and
// `auto` choose as if unset.
const requestedHostMode = process.env.DREAM_HOST_MODE?.trim() || "";

// Diagnostic only: opt-in via env var to test whether software rendering is
// caused by Chromium's GPU blocklist (do NOT enable in production builds —
// blocklist entries exist because the matched configs crash or misrender).
if (process.env.DREAM_IGNORE_GPU_BLOCKLIST === "1") {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  console.warn(
    "[gpu] --ignore-gpu-blocklist enabled via DREAM_IGNORE_GPU_BLOCKLIST (diagnostic mode)",
  );
}
const rendererUrlFromEnv = process.env.ELECTRON_RENDERER_URL?.trim();
const rendererStartupTimeoutMs = Number(
  process.env.VITE_READY_TIMEOUT_MS ?? 45000,
);
const rendererProbeIntervalMs = 300;
const APP_NAME = "Dream";
const APP_ID = "ai.dreamdream.dream";
const APP_USER_DATA_DIR_NAME = "dreamide";
const APP_USER_DATA_PATH = path.join(
  app.getPath("appData"),
  APP_USER_DATA_DIR_NAME,
);
const APP_SESSION_DATA_PATH = path.join(
  app.getPath("temp"),
  APP_USER_DATA_DIR_NAME,
  `session-${process.pid}`,
);
app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}
mkdirSync(APP_USER_DATA_PATH, { recursive: true });
mkdirSync(APP_SESSION_DATA_PATH, { recursive: true });
app.setPath("userData", APP_USER_DATA_PATH);
// Keep Chromium caches per process so parallel launches do not lock user data.
app.setPath("sessionData", APP_SESSION_DATA_PATH);

// The desktop's workspace and its local host's catalog are separate files,
// each with its own writer (workspace-database.js): the desktop's save
// queue writes the workspace, the host its catalog. Set up before either
// writer starts; an existing workspace moves out of the state database
// once, from a backed-up copy.
configureHostDataDirectory(APP_USER_DATA_PATH);
const STATE_DATABASE_PATH = resolveStateDatabasePath();
let WORKSPACE_DATABASE_PATH = STATE_DATABASE_PATH;
let workspaceSeparate = false;
try {
  const prepared = prepareWorkspaceDatabase({
    stateDatabasePath: STATE_DATABASE_PATH,
  });
  WORKSPACE_DATABASE_PATH = prepared.workspaceDatabasePath;
  workspaceSeparate = true;
  if (prepared.migrated) {
    console.log(
      `Moved the workspace to ${prepared.workspaceDatabasePath} (backup: ${prepared.backupPath}).`,
    );
  }
} catch (error) {
  // The workspace stays where it was, with the one shared writer it had:
  // nothing is lost, and the move is tried again at the next start.
  console.error("Could not move the workspace to its own database:", error);
}

// One desktop per workspace: two would be two writers of one file. A host
// in this process on the shared database takes the state lock instead.
let releaseWorkspaceLock = () => {};
if (workspaceSeparate) {
  try {
    releaseWorkspaceLock = acquireStateLock(WORKSPACE_DATABASE_PATH, {
      kind: "desktop",
    });
  } catch (error) {
    if (!(error instanceof StateLockedError)) throw error;
    dialog.showErrorBox(
      "Dream is already running",
      `Another Dream window (process ${error.holder?.pid ?? "unknown"}) is using this workspace. Switch to it, or quit it first.`,
    );
    process.exit(1);
  }
}

// The home host: the host running on this desktop's database (whoever
// started it) or one the desktop starts, or inside this process. All of them use this desktop's identity and catalog.
const resolvedHostMode = resolveDesktopHostMode({
  envMode: requestedHostMode,
  workspaceSeparate,
});
const resolveRemoteHost = (hostId) => desktopConnections.getEndpoint(hostId);
const createInProcessHost = () =>
  createHost({
    // The browser client paired devices load: this app's renderer build.
    clientDirectory: path.join(__dirname, "..", "dist"),
    dataDirectory: APP_USER_DATA_PATH,
    diagnosticsEnabled: !app.isPackaged,
    kind: "desktop",
    // Only while the workspace could not move out: then the host's catalog
    // writes share the workspace's queue, one writer for the one file.
    ...(workspaceSeparate
      ? {}
      : {
          getStateWriter: () => ({
            applyCatalogChanges: (changes) =>
              getStateSaveQueue().applyCatalogChanges(changes),
            mutateRunQueue: (operation) =>
              getStateSaveQueue().mutateRunQueue(operation),
            ready: () => getStateSaveQueue().ready(),
            saveChatMessages: (payload) =>
              getStateSaveQueue().saveChatMessages(payload),
            saveProviderSession: (payload) =>
              getStateSaveQueue().saveProviderSession(payload),
            settled: () => getStateSaveQueue().settled(),
            writeDeviceSession: (operation) =>
              getStateSaveQueue().writeDeviceSession(operation),
          }),
        }),
    version: dreamVersion,
    // Requests for SSH-host projects go through the local API to the host's
    // forwarded port (api/host-proxy-routes.js).
    resolveRemoteHost,
  });

const host = (() => {
  switch (resolvedHostMode.mode) {
    case "detached":
      // A host that cannot start in its own process, with nothing else on
      // the data, leaves the window working with a host in this one.
      return withInProcessFallback({
        attached: createHomeHostAttachment({
          clientDirectory: path.join(__dirname, "..", "dist"),
          dataDirectory: APP_USER_DATA_PATH,
          diagnosticsEnabled: !app.isPackaged,
          resolveRemoteHost,
          stateDatabasePath: STATE_DATABASE_PATH,
          version: dreamVersion,
        }),
        createInProcess: createInProcessHost,
        fallBack: true,
        stateDatabasePath: STATE_DATABASE_PATH,
      });
    default:
      return createInProcessHost();
  }
})();

/** The host mode now: a detached host that could not start fell back. */
const currentHostMode = () => host.mode ?? resolvedHostMode.mode;

let mainWindow = null;
let updateManager = null;
let installId = null;
let helloView = null;

// The saved theme preferences (theme-store.js), and the window's
// background painted from them.
const themes = createThemeStore({
  load: () =>
    loadPersistedThemePreference({ databasePath: WORKSPACE_DATABASE_PATH }),
  save: (preferences) => {
    getStateSaveQueue()
      .saveConfigValue(themePreferenceConfigValue(preferences))
      .catch((error) => {
        console.error("Failed to save theme preference:", error);
      });
  },
});

function getAliveMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

const browserSessionManager = createBrowserSessionManager({
  getMainWindow: () => mainWindow,
  sendToRenderer,
});

// Lets agent tools (electron/api/chat/browser-tools.js) drive the renderer's
// browser tabs. The API layer reads it through the browser-bridge holder.
const browserAgentBridge = createBrowserAgentBridge({ sendToRenderer });
setBrowserBridge(browserAgentBridge);

const processSessionManager = host.processSessions;

// Logical host connections select routes behind the desktop adapter. SSH
// prompts (passwords, 2FA, unknown keys) still go through the window.
const sshPrompts = createSshPromptBroker({
  canAsk: () => getAliveMainWindow() !== null,
  send: (prompt) => sendToRenderer(desktopChannel("onHostPrompt"), prompt),
});

const desktopConnections = createDesktopHostConnections({
  httpsRoutes: createHttpsRoutes({
    credentials: createDeviceCredentials({
      file: `${WORKSPACE_DATABASE_PATH}.device-credentials`,
      safeStorage,
    }),
  }),
  onPrompt: (prompt) => sshPrompts.ask(prompt),
  onStatus: (status) => {
    console.log(
      `[connections] ${status.hostId}: ${status.state}${status.routeId ? ` via ${status.routeId}` : ""}${status.error ? ` (${status.error})` : ""}`,
    );
    sendToRenderer(desktopChannel("onHostStatus"), {
      error: status.error ?? null,
      hostId: status.hostId,
      state: status.state,
      routeId: status.routeId,
      routes: status.routes,
      version: status.endpoint?.version ?? null,
    });
  },
  stateDirectory: path.join(os.homedir(), ".dream", "ssh"),
});

let rendererServerManager = null;

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function isDevToolsShortcut(input) {
  const key = typeof input?.key === "string" ? input.key.toLowerCase() : "";
  return (
    input?.type === "keyDown" &&
    key === "i" &&
    input.control &&
    input.shift &&
    !input.alt &&
    !input.meta
  );
}

// Stop desktop-owned terminals before unload. With a detached host the
// desktop owns no processes, so its guard only reloads/detaches the page.
const rendererUnloadGuard = createRendererUnloadGuard({
  processes: processSessionManager,
});

function reloadMainWindow(browserWindow, options) {
  const targetWindow =
    browserWindow && !browserWindow.isDestroyed() ? browserWindow : mainWindow;
  return rendererUnloadGuard.reload(targetWindow?.webContents, options);
}

// True for the main renderer and for <webview> guests embedded in it (the
// browser panel), so the shortcut works wherever focus is inside the app.
function belongsToMainWindow(contents) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const mainContentsId = mainWindow.webContents.id;
  return (
    contents.id === mainContentsId ||
    contents.hostWebContents?.id === mainContentsId
  );
}

// The renderer runs the capture (via app:capture-screenshot) so it can first
// hide its own screenshot toast and keep it out of the image.
function requestAppScreenshot() {
  sendToRenderer(desktopChannel("onAppScreenshotRequested"));
}

function configureDetachedDevToolsShortcuts() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("before-input-event", (event, input) => {
      if (isDevToolsShortcut(input)) {
        event.preventDefault();
        toggleWebContentsDevToolsDetached(contents);
        return;
      }

      if (isAppScreenshotShortcut(input) && belongsToMainWindow(contents)) {
        event.preventDefault();
        requestAppScreenshot();
        return;
      }

      const reloadOptions = getReloadShortcutOptions(input);
      if (!reloadOptions) {
        return;
      }

      // Only gate reload for the main renderer — not embedded webviews.
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      if (contents.id !== mainWindow.webContents.id) {
        return;
      }

      event.preventDefault();
      void reloadMainWindow(mainWindow, reloadOptions);
    });
  });
}

async function createStartupRendererServerManager() {
  const configuredApiServerPort = parsePort(process.env.ELECTRON_API_PORT);
  const configuredInternalRendererPort = parsePort(
    process.env.ELECTRON_INTERNAL_PORT,
  );
  const apiServerPort =
    configuredApiServerPort ??
    (await getPort({
      exclude:
        configuredInternalRendererPort === null
          ? undefined
          : [configuredInternalRendererPort],
      host: "127.0.0.1",
      reserve: true,
    }));
  const internalRendererPort =
    configuredInternalRendererPort ??
    (await getPort({
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
    `Starting ${APP_NAME} with renderer port ${internalRendererPort} and API port ${apiServerPort}.`,
  );

  return createRendererServerManager({
    apiServerPort,
    appDir: __dirname,
    developmentRendererUrl:
      rendererUrlFromEnv || `http://127.0.0.1:${internalRendererPort}`,
    internalRendererPort,
    isDevelopment,
    rendererProbeIntervalMs,
    rendererStartupTimeoutMs,
    rendererUrlFromEnv,
    startApi: ({ apiToken, port }) => host.listen({ apiToken, port }),
    onRendererOutput: devLogger
      ? (text) => devLogger.log("vite", text)
      : undefined,
  });
}

function getUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isRendererNavigation(url) {
  if (!rendererServerManager) {
    return false;
  }

  const targetOrigin = getUrlOrigin(url);
  const rendererOrigin = getUrlOrigin(rendererServerManager.getUrl());

  if (!targetOrigin || !rendererOrigin) {
    return false;
  }

  return targetOrigin === rendererOrigin;
}

async function configureRendererProxy(webContents) {
  try {
    const proxyConfig = isDevelopment
      ? { mode: "direct" }
      : {
          mode: "system",
          proxyBypassRules: "localhost,127.0.0.1,::1,<local>",
        };

    await webContents.session.setProxy(proxyConfig);

    await webContents.session.forceReloadProxyConfig();
  } catch (error) {
    console.error("Failed to configure renderer proxy settings:", error);
  }
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: themes.windowBackground(nativeTheme.shouldUseDarkColors),
    height: 1080,
    minHeight: 720,
    minWidth: 1180,
    icon:
      process.platform === "darwin" || !existsSync(appIconPath)
        ? undefined
        : appIconPath,
    show: false,
    title: APP_NAME,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin" && { frame: false }),
    trafficLightPosition:
      process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      spellcheck: false,
      webviewTag: true,
    },
    width: 1920,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isRendererNavigation(url)) {
      browserSessionManager.hideForRendererNavigation();

      // Interrupt in-app navigations/reloads long enough to tear down PTYs
      // first; otherwise shell processes keep running after the renderer dies.
      const held = rendererUnloadGuard.holdNavigation(() => {
        getAliveMainWindow()
          ?.loadURL(url)
          .catch((error) => {
            console.error(
              "Failed to load renderer after stopping processes:",
              error,
            );
          });
      });
      if (held) event.preventDefault();
      return;
    }

    event.preventDefault();

    if (isHttpUrl(url)) {
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on(
    "did-start-navigation",
    (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace || !isRendererNavigation(url)) {
        return;
      }

      browserSessionManager.hideForRendererNavigation();
      // Safety net for reload paths that skip will-navigate (e.g. DevTools
      // reload, webContents.reload after cleanup, some Chromium reload paths).
      void rendererUnloadGuard.stopProcesses();
    },
  );

  mainWindow.webContents.on("render-process-gone", () => {
    browserSessionManager.hideForRendererNavigation();
    void rendererUnloadGuard.stopProcesses();
  });

  // Throttle embedded-view layout during interactive resize. Windows fires
  // "resize" far more often than macOS during live drag-resize; running
  // applyState() per event causes main-process jank there.
  const RESIZE_THROTTLE_MS = 32;
  let resizeFrame = null;
  mainWindow.on("resize", () => {
    if (resizeFrame !== null) return;
    resizeFrame = setTimeout(() => {
      resizeFrame = null;
      browserSessionManager.applyState();
    }, RESIZE_THROTTLE_MS);
  });

  // Emitted once when an interactive resize ends (Windows/macOS): cancel any
  // pending throttled pass and sync the embedded views to the final bounds.
  mainWindow.on("resized", () => {
    if (resizeFrame !== null) {
      clearTimeout(resizeFrame);
      resizeFrame = null;
    }
    browserSessionManager.applyState();
  });

  mainWindow.on("closed", () => {
    if (helloView && !helloView.webContents.isDestroyed()) {
      helloView.webContents.close();
    }
    helloView = null;
    browserSessionManager.reset();
    browserAgentBridge.reset();
    mainWindow = null;
  });

  await configureRendererProxy(mainWindow.webContents);

  if (!isDevelopment && process.env.DREAM_DISABLE_HELLO !== "1") {
    helloView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    helloView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.contentView.addChildView(helloView);
    helloView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    helloView.webContents
      .loadURL(
        getHelloUrl({
          currentVersion: app.getVersion(),
          installId,
        }),
      )
      .catch(() => {});
  }

  mainWindow.loadURL(rendererServerManager.getUrl()).catch((error) => {
    console.error("Failed to load renderer:", error);
  });
}

ipcMain.on(DESKTOP_SYNC_CHANNELS.apiSessionToken, (event) => {
  const apiSessionToken = rendererServerManager?.getApiSessionToken();
  if (!apiSessionToken) {
    console.error(
      "API session token requested before renderer server startup.",
    );
    event.returnValue = "";
    return;
  }

  event.returnValue = apiSessionToken;
});

// The workspace's reads and writes stay off the main thread. The queue runs
// them in order: workspace changes, config values and the workspace load a
// reloaded window makes. (The host's catalog has its own writer.)
let stateSaveQueue = null;
const getStateSaveQueue = () =>
  (stateSaveQueue ??= createStateSaveQueue({
    databasePath: WORKSPACE_DATABASE_PATH,
  }));

ipcMain.on(DESKTOP_SYNC_CHANNELS.initialThemePreferences, (event) => {
  event.returnValue = themes.get();
});

ipcMain.on(DESKTOP_SYNC_CHANNELS.hostMode, (event) => {
  event.returnValue = currentHostMode();
});

// Every desktop method the renderer calls (desktop-handlers.js), on its
// channel (shared/desktop-channels.js).
const desktop = createDesktopHandlers({
  browserSessions: browserSessionManager,
  captureAppScreenshot,
  editors: { detect: detectAvailableEditors, open: openProjectInEditor },
  electron: { ClipboardItem, clipboard, dialog, Notification, shell },
  files: {
    exists: existsSync,
    writeFile: (filePath, contents) => writeFile(filePath, contents, "utf8"),
  },
  getPath: (name) => app.getPath(name),
  getWindow: getAliveMainWindow,
  hostname: () => os.hostname(),
  sendToRenderer,
  sshConfigHosts: () => readSshConfigHosts(),
  sshHosts: desktopConnections,
  sshPrompts,
  state: {
    loadWorkspace: () => getStateSaveQueue().loadWorkspace(),
    saveWorkspaceChanges: (changes) =>
      getStateSaveQueue().saveWorkspaceChanges(changes),
  },
  systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
  themes,
});
registerDesktopHandlers(ipcMain, desktop.handlers);

nativeTheme.on("updated", () => {
  desktop.paintWindowBackground();
});

app
  .whenReady()
  .then(async () => {
    const projectRoot = path.resolve(__dirname, "..");
    if (devInspectionEnabled) {
      devLogger = await createDevLogger(projectRoot).catch(() => null);
    }
    configureDetachedDevToolsShortcuts();
    configureApplicationMenu(app, APP_NAME, {
      onCaptureScreenshot: requestAppScreenshot,
      onForceReload: (browserWindow) => {
        void reloadMainWindow(browserWindow, { ignoreCache: true });
      },
      onReload: (browserWindow) => {
        void reloadMainWindow(browserWindow);
      },
    });

    if (process.platform === "darwin" && existsSync(appIconPath)) {
      app.dock?.setIcon(appIconPath);
    }

    rendererServerManager = await createStartupRendererServerManager();
    await rendererServerManager.start();
    // Remote access as the user left it (Settings > Remote access). Never
    // holds the window up: its setup can wait on Tailscale.
    void host
      .startRemoteAccess()
      .catch((error) => console.warn("Remote access did not start:", error));
    if (devInspectionEnabled) {
      await publishDevSession(projectRoot, {
        kind: "electron",
        rendererUrl: rendererServerManager.getUrl(),
        apiUrl: `http://127.0.0.1:${rendererServerManager.getApiServerPort()}`,
        debugUrl: app.commandLine.hasSwitch("remote-debugging-port")
          ? `http://127.0.0.1:${app.commandLine.getSwitchValue("remote-debugging-port")}/json/list`
          : null,
        logPath: devLogger?.logPath ?? null,
      }).catch((error) => console.warn("Cannot publish dev session:", error));
    }

    try {
      const persisted = readOrCreatePersistedInstallId({
        databasePath: WORKSPACE_DATABASE_PATH,
      });
      installId = persisted.installId;
      if (persisted.created) {
        getStateSaveQueue()
          .saveConfigValue(installIdConfigValue(installId))
          .catch((error) => {
            console.error("Failed to save install ID:", error);
          });
      }
    } catch (error) {
      console.error("Failed to initialize install ID:", error);
    }

    await createMainWindow();
    if (devLogger) {
      mainWindow.webContents.on("console-message", (_event, details) => {
        devLogger.log(`renderer:${details.level}`, details.message);
      });
    }

    updateManager = initializeAutoUpdater({
      app,
      getMainWindow: () => mainWindow,
      ipcMain,
      isDevelopment,
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  })
  .catch((error) => {
    console.error("Desktop startup failed:", error);
    dialog.showErrorBox("Could not start Dream", error.message);
    app.quit();
  });

// Electron does not wait for async "before-quit" listeners, so we must
// preventDefault, finish cleanup (including flushing any state save still
// queued in the worker), and then re-trigger quit ourselves. Without this,
// the final renderer-side persist could be lost on exit.
let quitCleanupDone = false;
app.on("before-quit", (event) => {
  if (quitCleanupDone) {
    return;
  }
  event.preventDefault();

  updateManager?.stop();

  Promise.resolve()
    .then(async () => {
      await host.close();
      await desktopConnections.disconnectAll();
      await rendererServerManager?.stop();
      await stateSaveQueue?.flushAndClose();
      closePersistedStateDatabase();
      releaseWorkspaceLock();
    })
    .catch((error) => {
      console.error("Error during quit cleanup:", error);
    })
    .finally(() => {
      quitCleanupDone = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || isDevelopment) {
    app.quit();
  }
});
