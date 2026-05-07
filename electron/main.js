import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from "electron";

import { configureApplicationMenu } from "./app-menu.js";
import { createBrowserSessionManager } from "./browser-sessions.js";
import { detectAvailableEditors, openProjectInEditor } from "./editors.js";
import {
  closePersistedStateDatabase,
  loadPersistedState,
  savePersistedState,
} from "./persisted-state.js";
import { createProcessSessionManager } from "./process-sessions.js";
import { createRendererServerManager } from "./renderer-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appIconPath = path.join(__dirname, "..", "public", "icon.png");

const isDevelopment = process.env.NODE_ENV === "development";
const internalRendererPort = Number(process.env.ELECTRON_INTERNAL_PORT ?? 3210);
const rendererUrlFromEnv = process.env.ELECTRON_RENDERER_URL?.trim();
const developmentRendererUrl =
  rendererUrlFromEnv || `http://127.0.0.1:${internalRendererPort}`;
const apiServerPort = Number(process.env.ELECTRON_API_PORT ?? 3211);
const disableTerminalShell =
  process.env.DREAM_DISABLE_TERMINAL_SHELL === "1" ||
  process.env.DREAM_DISABLE_TERMINAL_SHELL === "true";
const debugTerminalStartup =
  process.env.DREAM_DEBUG_TERMINAL_STARTUP === "1" ||
  process.env.DREAM_DEBUG_TERMINAL_STARTUP === "true";
const rendererStartupTimeoutMs = Number(
  process.env.VITE_READY_TIMEOUT_MS ?? 45000,
);
const rendererProbeIntervalMs = 300;
const APP_NAME = "Dream";
const APP_USER_DATA_PATH = path.join(app.getPath("appData"), APP_NAME);
const THEME_PREFERENCES_PATH = path.join(
  APP_USER_DATA_PATH,
  "theme-preferences.json",
);
const DARK_WINDOW_BACKGROUND = "#09090b";
const LIGHT_WINDOW_BACKGROUND = "#ffffff";

app.setName(APP_NAME);
app.setPath("userData", APP_USER_DATA_PATH);

let mainWindow = null;

function normalizeThemePreference(value) {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "dark";
}

function loadThemePreference() {
  try {
    if (!existsSync(THEME_PREFERENCES_PATH)) {
      return "dark";
    }

    const parsed = JSON.parse(readFileSync(THEME_PREFERENCES_PATH, "utf8"));
    return normalizeThemePreference(parsed?.theme);
  } catch {
    return "dark";
  }
}

function saveThemePreference(theme) {
  try {
    mkdirSync(APP_USER_DATA_PATH, { recursive: true });
    writeFileSync(
      THEME_PREFERENCES_PATH,
      JSON.stringify({ theme: normalizeThemePreference(theme) }),
    );
  } catch (error) {
    console.error("Failed to save theme preference:", error);
  }
}

function getResolvedThemePreference(theme = loadThemePreference()) {
  const normalizedTheme = normalizeThemePreference(theme);
  if (normalizedTheme === "system") {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }

  return normalizedTheme;
}

function getWindowBackground(theme = loadThemePreference()) {
  return getResolvedThemePreference(theme) === "dark"
    ? DARK_WINDOW_BACKGROUND
    : LIGHT_WINDOW_BACKGROUND;
}

function applyWindowThemeBackground(theme = loadThemePreference()) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setBackgroundColor(getWindowBackground(theme));
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

const processSessionManager = createProcessSessionManager({
  debugTerminalStartup,
  disableTerminalShell,
  sendToRenderer,
});

const rendererServerManager = createRendererServerManager({
  apiServerPort,
  appDir: __dirname,
  developmentRendererUrl,
  internalRendererPort,
  isDevelopment,
  rendererProbeIntervalMs,
  rendererStartupTimeoutMs,
  rendererUrlFromEnv,
});

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
    },
    width: 1920,
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
    },
  );

  mainWindow.webContents.on("render-process-gone", () => {
    browserSessionManager.hideForRendererNavigation();
  });

  let resizeFrame = null;
  mainWindow.on("resize", () => {
    if (resizeFrame !== null) return;
    resizeFrame = setTimeout(() => {
      resizeFrame = null;
      browserSessionManager.applyState();
    }, 0);
  });

  mainWindow.on("closed", () => {
    browserSessionManager.reset();
    mainWindow = null;
  });

  await configureRendererProxy(mainWindow.webContents);

  mainWindow.loadURL(rendererServerManager.getUrl()).catch((error) => {
    console.error("Failed to load renderer:", error);
  });
}

ipcMain.handle("projects:pick-directory", pickDirectory);
ipcMain.handle("state:load", () => loadPersistedState());

ipcMain.handle("state:save", (_event, state) => savePersistedState(state));

ipcMain.handle("theme:set", (_event, { theme } = {}) => {
  const normalizedTheme = normalizeThemePreference(theme);
  saveThemePreference(normalizedTheme);
  applyWindowThemeBackground(normalizedTheme);
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

ipcMain.handle("shell:open-external", (_event, { url }) => {
  if (!url || typeof url !== "string" || !isHttpUrl(url)) {
    return false;
  }

  shell.openExternal(url);
  return true;
});

ipcMain.handle("terminal:get-default-shell", () => {
  return processSessionManager.getDefaultTerminalShellCommand();
});

ipcMain.handle("clipboard:write-text", (_event, { text }) => {
  if (typeof text !== "string") {
    return false;
  }

  clipboard.writeText(text);
  return true;
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

ipcMain.handle("editors:open", (_event, { projectPath, editorId }) => {
  return openProjectInEditor({ editorId, projectPath });
});

ipcMain.handle(
  "runner:start",
  (_event, { command, cwd, projectId, projectName }) => {
    return processSessionManager.startRunner({
      command,
      cwd,
      projectId,
      projectName,
    });
  },
);

ipcMain.handle("runner:stop", (_event, { projectId }) => {
  if (!projectId) {
    return false;
  }

  processSessionManager.stopRunProcess(projectId);
  return true;
});

ipcMain.handle(
  "terminal:start",
  (_event, { command, cwd, projectId, shellPath: preferredShellPath }) => {
    return processSessionManager.startTerminal({
      command,
      cwd,
      projectId,
      shellPath: preferredShellPath,
    });
  },
);

ipcMain.on("terminal:input", (_event, payload) => {
  processSessionManager.writeTerminalInput(payload);
});

ipcMain.on("terminal:resize", (_event, payload) => {
  processSessionManager.resizeTerminal(payload);
});

ipcMain.handle("terminal:stop", (_event, { projectId }) => {
  if (!projectId) {
    return false;
  }

  processSessionManager.stopTerminalSession(projectId);
  return true;
});

ipcMain.on("browser:update", (_event, payload) => {
  browserSessionManager.update(payload);
});

app.whenReady().then(async () => {
  configureApplicationMenu(app, APP_NAME);

  if (process.platform === "darwin" && existsSync(appIconPath)) {
    app.dock?.setIcon(appIconPath);
  }

  await rendererServerManager.start();
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("before-quit", async () => {
  processSessionManager.stopAllProcesses();

  await rendererServerManager.stop();

  closePersistedStateDatabase();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || isDevelopment) {
    app.quit();
  }
});
