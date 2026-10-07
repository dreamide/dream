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
  shell,
  WebContentsView,
} from "electron";
import getPort from "get-port";
import { setBrowserBridge } from "./api/browser-bridge.js";
import { stopCodexAppServer } from "./api/chat/codex-app-server-client.js";
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
import { createDevLogger, publishDevSession } from "./dev-inspection.js";
import { detectAvailableEditors, openProjectInEditor } from "./editors.js";
import { getHelloUrl } from "./hello.js";
import { createHost } from "./host/index.js";
import {
  closePersistedStateDatabase,
  ensurePersistedInstallId,
  loadPersistedThemePreference,
  resolveStateDatabasePath,
  savePersistedThemePreference,
} from "./persisted-state.js";
import { createRendererServerManager } from "./renderer-server.js";
import { DEV_RUNTIME_VERSION } from "./ssh/host-install.js";
import { createSshHostManager } from "./ssh/ssh-hosts.js";
import { createStateSaveQueue } from "./state-save-queue.js";
import { initializeAutoUpdater } from "./updater.js";

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
const LIGHT_WINDOW_BACKGROUND = "#ffffff";
const DARK_WINDOW_BACKGROUNDS = {
  neutral: "#0a0a0a",
  slate: "#020617",
  gray: "#030712",
  zinc: "#09090b",
  stone: "#0c0a09",
};
const DEFAULT_THEME_PREFERENCES = {
  accentColor: "green",
  baseColor: "zinc",
  theme: "dark",
};

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}
mkdirSync(APP_USER_DATA_PATH, { recursive: true });
mkdirSync(APP_SESSION_DATA_PATH, { recursive: true });
app.setPath("userData", APP_USER_DATA_PATH);
// Keep Chromium caches per process so parallel launches do not lock user data.
app.setPath("sessionData", APP_SESSION_DATA_PATH);

// The local host: projects on this machine are served by the same host
// module an SSH host runs as a daemon. It keeps its files in userData.
const host = createHost({
  dataDirectory: APP_USER_DATA_PATH,
  diagnosticsEnabled: !app.isPackaged,
  // The host's catalog writes share the workspace's save queue: one writer
  // per database file, and a reloaded renderer waits for them (state:load).
  getStateWriter: () => ({
    applyCatalogChanges: (changes) =>
      getStateSaveQueue().applyCatalogChanges(changes),
    saveChatMessages: (payload) =>
      getStateSaveQueue().saveChatMessages(payload),
  }),
  version: dreamVersion,
  // Requests for SSH-host projects go through the local API to the host's
  // forwarded port (api/host-proxy-routes.js).
  resolveRemoteHost: (hostId) => sshHosts.getEndpoint(hostId),
});

let mainWindow = null;
let updateManager = null;
let installId = null;
let helloView = null;

function normalizeThemePreference(value) {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "dark";
}

function loadThemePreference() {
  try {
    const parsed = loadPersistedThemePreference();
    return {
      accentColor: parsed?.accentColor ?? DEFAULT_THEME_PREFERENCES.accentColor,
      theme: normalizeThemePreference(parsed?.theme),
      baseColor: parsed?.baseColor ?? DEFAULT_THEME_PREFERENCES.baseColor,
    };
  } catch {
    return DEFAULT_THEME_PREFERENCES;
  }
}

function saveThemePreference(theme, baseColor, accentColor) {
  try {
    const existing = loadThemePreference();
    const data = {
      accentColor: accentColor ?? existing.accentColor,
      theme: normalizeThemePreference(theme ?? existing.theme),
      baseColor: baseColor ?? existing.baseColor,
    };
    savePersistedThemePreference(data);
  } catch (error) {
    console.error("Failed to save theme preference:", error);
  }
}

function getResolvedThemePreference(theme) {
  const normalizedTheme = normalizeThemePreference(
    theme ?? loadThemePreference().theme,
  );
  if (normalizedTheme === "system") {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }

  return normalizedTheme;
}

function getWindowBackground(theme, baseColor) {
  const prefs = loadThemePreference();
  const resolvedTheme = getResolvedThemePreference(theme ?? prefs.theme);
  if (resolvedTheme === "light") {
    return LIGHT_WINDOW_BACKGROUND;
  }
  const color = baseColor ?? prefs.baseColor ?? "zinc";
  return DARK_WINDOW_BACKGROUNDS[color] ?? DARK_WINDOW_BACKGROUNDS.zinc;
}

function applyWindowThemeBackground(theme, baseColor) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setBackgroundColor(getWindowBackground(theme, baseColor));
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

// Connections to SSH hosts' daemons, opened by the renderer (hosts:connect)
// for its projects on those hosts. ssh's prompts (passwords, 2FA, unknown
// host keys) are asked in the window and answered back (hosts:prompt).
const SSH_PROMPT_TIMEOUT_MS = 5 * 60_000;
const pendingSshPrompts = new Map();
let nextSshPromptId = 1;

const sshHosts = createSshHostManager({
  onPrompt: ({ hostId, kind, message, target }) =>
    new Promise((resolve) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        resolve(null);
        return;
      }
      const promptId = nextSshPromptId++;
      const timer = setTimeout(() => {
        pendingSshPrompts.delete(promptId);
        resolve(null);
      }, SSH_PROMPT_TIMEOUT_MS);
      pendingSshPrompts.set(promptId, (answer) => {
        clearTimeout(timer);
        pendingSshPrompts.delete(promptId);
        resolve(typeof answer === "string" ? answer : null);
      });
      sendToRenderer("hosts:prompt", {
        hostId,
        kind,
        message,
        promptId,
        target,
      });
    }),
  onStatus: (status) => {
    console.log(
      `[ssh] ${status.hostId}: ${status.state}${status.error ? ` (${status.error})` : ""}`,
    );
    sendToRenderer("hosts:status", {
      error: status.error ?? null,
      hostId: status.hostId,
      state: status.state,
      version: status.endpoint?.version ?? null,
    });
  },
  stateDirectory: path.join(os.homedir(), ".dream", "ssh"),
  // A host without its own host command gets this version installed. A
  // development build has nothing published: its runtime is built on the
  // host from the working tree (pnpm host:install-dev <target>).
  runtimeVersion: app.isPackaged ? dreamVersion : DEV_RUNTIME_VERSION,
});

ipcMain.handle(
  "hosts:connect",
  async (_event, { hostId, hostCommand, target } = {}) => {
    if (
      typeof hostId !== "string" ||
      typeof target !== "string" ||
      !target.trim()
    ) {
      throw new Error("A host needs an id and an SSH target.");
    }
    const endpoint = await sshHosts.connect({
      hostCommand:
        typeof hostCommand === "string" && hostCommand.trim()
          ? hostCommand.trim()
          : undefined,
      hostId,
      target: target.trim(),
    });
    // The token stays in this process; the renderer goes through the proxy.
    return {
      hostProtocolVersion: endpoint.hostProtocolVersion,
      version: endpoint.version ?? null,
    };
  },
);

ipcMain.handle("hosts:disconnect", (_event, { hostId } = {}) => {
  if (typeof hostId === "string") sshHosts.disconnect(hostId);
  return true;
});

ipcMain.handle("hosts:state", (_event, { hostId } = {}) =>
  typeof hostId === "string" ? sshHosts.getState(hostId) : "idle",
);

// A port on an SSH host (its dev server) forwarded here, for the browser
// panel; resolves with the local port.
ipcMain.handle("hosts:forward-port", (_event, { hostId, port } = {}) => {
  const remotePort = Number(port);
  if (
    typeof hostId !== "string" ||
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65_535
  ) {
    throw new Error("A host and a port are needed.");
  }
  return sshHosts.forwardPort(hostId, remotePort);
});

ipcMain.on("hosts:prompt-answer", (_event, { answer, promptId } = {}) => {
  pendingSshPrompts.get(promptId)?.(answer);
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

// Returns reload options when the keystroke is a page-reload shortcut, else null.
// F5 / Ctrl+F5 and Ctrl/Cmd(+Shift)+R must be handled in the main process so we
// can stop terminal/run sessions before the renderer tears down.
function getReloadShortcutOptions(input) {
  if (input?.type !== "keyDown") {
    return null;
  }

  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";

  if (key === "f5" && !input.alt && !input.meta) {
    return { ignoreCache: Boolean(input.control) };
  }

  if (
    key === "r" &&
    (input.control || input.meta) &&
    !input.alt &&
    !input.isAutoRepeat
  ) {
    return { ignoreCache: Boolean(input.shift) };
  }

  return null;
}

let rendererUnloadStopPromise = null;

function stopProcessesForRendererUnload() {
  if (!rendererUnloadStopPromise) {
    rendererUnloadStopPromise = processSessionManager
      .stopAllProcesses()
      .catch((error) => {
        console.error(
          "Failed to stop managed processes before renderer unload:",
          error,
        );
      })
      .finally(() => {
        rendererUnloadStopPromise = null;
      });
  }

  return rendererUnloadStopPromise;
}

let reloadMainWindowPromise = null;

async function reloadMainWindow(browserWindow, { ignoreCache = false } = {}) {
  if (reloadMainWindowPromise) {
    return reloadMainWindowPromise;
  }

  reloadMainWindowPromise = (async () => {
    const targetWindow =
      browserWindow && !browserWindow.isDestroyed()
        ? browserWindow
        : mainWindow;
    const webContents = targetWindow?.webContents;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }

    await stopProcessesForRendererUnload();

    if (webContents.isDestroyed()) {
      return;
    }

    if (ignoreCache) {
      webContents.reloadIgnoringCache();
    } else {
      webContents.reload();
    }
  })().finally(() => {
    reloadMainWindowPromise = null;
  });

  return reloadMainWindowPromise;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPngBytes(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.length > PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  );
}

// Electron 44 removed clipboard.writeImage; images go through the
// W3C-style clipboard.write([ClipboardItem]) API instead.
function writePngToClipboard(png) {
  return clipboard.write([
    new ClipboardItem({
      "image/png": new Blob([png], { type: "image/png" }),
    }),
  ]);
}

// Folder of the last saved screenshot, so the next Save dialog opens there.
// Starts in the user's Pictures folder; not persisted across launches.
let lastAppScreenshotDirectory = null;
// Paths saved this session; "Show in folder" only reveals these.
const savedAppScreenshotPaths = new Set();

async function chooseAppScreenshotSavePath(defaultFileName) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const directory = lastAppScreenshotDirectory ?? app.getPath("pictures");
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(directory, defaultFileName),
    filters: [{ extensions: ["png"], name: "PNG image" }],
    title: "Save screenshot",
  });

  return result.canceled || !result.filePath ? null : result.filePath;
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
  sendToRenderer("app:screenshot-requested");
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value.trim());
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

async function pickDirectory() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select project folder",
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0] ?? null;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: getWindowBackground(),
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
      if (processSessionManager.hasActiveSessions()) {
        event.preventDefault();
        void stopProcessesForRendererUnload().then(() => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            return;
          }

          mainWindow.loadURL(url).catch((error) => {
            console.error(
              "Failed to load renderer after stopping processes:",
              error,
            );
          });
        });
      }
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
      void stopProcessesForRendererUnload();
    },
  );

  mainWindow.webContents.on("render-process-gone", () => {
    browserSessionManager.hideForRendererNavigation();
    void stopProcessesForRendererUnload();
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

ipcMain.handle("projects:pick-directory", pickDirectory);
// Read by the save worker, after every write queued before it: a refreshed
// renderer sees what the old document saved, and the main thread never
// waits on SQLite.
ipcMain.handle("state:load", () => getStateSaveQueue().loadWorkspace());
ipcMain.on("api:get-session-token", (event) => {
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

// SQLite state reads and writes stay off the main thread so even a large
// completed chat cannot delay input-event delivery. The queue runs them in
// order: workspace changes, catalog changes, transcripts and the workspace
// load a reloaded window makes.
let stateSaveQueue = null;
const getStateSaveQueue = () =>
  (stateSaveQueue ??= createStateSaveQueue({
    databasePath: resolveStateDatabasePath(),
  }));

ipcMain.handle("state:save-workspace", (_event, changes) =>
  getStateSaveQueue().saveWorkspaceChanges(changes),
);

ipcMain.handle("theme:set", (_event, { theme } = {}) => {
  const normalizedTheme = normalizeThemePreference(theme);
  saveThemePreference(normalizedTheme);
  applyWindowThemeBackground(normalizedTheme);
  return true;
});

ipcMain.handle("theme:get-preferences", () => loadThemePreference());

ipcMain.on("theme:get-initial-preferences", (event) => {
  event.returnValue = loadThemePreference();
});

ipcMain.handle("theme:set-base-color", (_event, { baseColor } = {}) => {
  saveThemePreference(null, baseColor);
  applyWindowThemeBackground(null, baseColor);
  return true;
});

ipcMain.handle("theme:set-accent-color", (_event, { accentColor } = {}) => {
  saveThemePreference(null, null, accentColor);
  return true;
});

nativeTheme.on("updated", () => {
  applyWindowThemeBackground();
});

// Window controls (Windows/Linux frameless window)
ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});
ipcMain.handle("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.handle("window:close", () => {
  mainWindow?.close();
});

// Desktop notifications for chat activity. Shown ones are held until they
// close: a collected notification never delivers its click.
const shownNotifications = new Set();
ipcMain.handle("notifications:show", (_event, payload = {}) => {
  const { body, chatId, silent, title } = payload;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    !Notification.isSupported()
  ) {
    return false;
  }

  const notification = new Notification({
    body: typeof body === "string" ? body.slice(0, 500) : "",
    silent: silent === true,
    title: title.slice(0, 200),
  });
  const release = () => shownNotifications.delete(notification);
  notification.on("click", () => {
    release();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    if (typeof chatId === "string" && chatId) {
      sendToRenderer("notifications:clicked", { chatId });
    }
  });
  notification.on("close", release);
  notification.on("failed", release);
  shownNotifications.add(notification);
  notification.show();
  return true;
});

ipcMain.handle("shell:open-external", (_event, { url }) => {
  if (!url || typeof url !== "string" || !isHttpUrl(url)) {
    return false;
  }

  shell.openExternal(url);
  return true;
});

ipcMain.handle("shell:open-path", async (_event, { path: targetPath }) => {
  if (
    !targetPath ||
    typeof targetPath !== "string" ||
    !path.isAbsolute(targetPath)
  ) {
    return false;
  }

  const errorMessage = await shell.openPath(targetPath);
  return errorMessage === "";
});

ipcMain.handle("app:capture-screenshot", async () => {
  const result = await captureAppScreenshot({
    chooseSavePath: chooseAppScreenshotSavePath,
    copyPng: writePngToClipboard,
    webContents: mainWindow?.webContents,
  });

  if (result.status === "saved") {
    savedAppScreenshotPaths.add(result.filePath);
    lastAppScreenshotDirectory = path.dirname(result.filePath);
  }

  return result;
});

ipcMain.handle(
  "app:show-screenshot-in-folder",
  (_event, { path: targetPath }) => {
    if (!savedAppScreenshotPaths.has(targetPath) || !existsSync(targetPath)) {
      return false;
    }

    shell.showItemInFolder(targetPath);
    return true;
  },
);

ipcMain.handle("clipboard:write-text", (_event, { text }) => {
  if (typeof text !== "string") {
    return false;
  }

  clipboard.writeText(text);
  return true;
});

ipcMain.handle("clipboard:write-image", async (_event, { png }) => {
  if (!isPngBytes(png)) {
    return false;
  }

  try {
    await writePngToClipboard(png);
    return true;
  } catch (error) {
    console.error("Failed to copy image to clipboard:", error);
    return false;
  }
});

ipcMain.handle(
  "files:save-text",
  async (_event, { contents, defaultPath, title = "Save file" }) => {
    if (typeof contents !== "string") {
      return false;
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath:
        typeof defaultPath === "string" && defaultPath.trim()
          ? defaultPath.trim()
          : undefined,
      title,
    });

    if (result.canceled || !result.filePath) {
      return false;
    }

    await writeFile(result.filePath, contents, "utf8");
    return true;
  },
);

ipcMain.handle("editors:detect", () => {
  return detectAvailableEditors();
});

ipcMain.handle(
  "editors:open",
  (_event, { projectPath, editorId, sshTarget }) => {
    return openProjectInEditor({ editorId, projectPath, sshTarget });
  },
);

ipcMain.on("browser:update", (_event, payload) => {
  browserSessionManager.update(payload);
});

ipcMain.handle("browser:capture-page", (_event, payload) =>
  browserSessionManager.capturePage(payload),
);

app.whenReady().then(async () => {
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
    installId = ensurePersistedInstallId();
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
      await stopCodexAppServer();
      await host.close();
      await sshHosts.disconnectAll();
      await rendererServerManager?.stop();
      await stateSaveQueue?.flushAndClose();
      closePersistedStateDatabase();
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
