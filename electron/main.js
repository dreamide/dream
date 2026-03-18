import { spawn as spawnProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  WebContentsView,
} from "electron";
import Store from "electron-store";
import { spawn as spawnPty } from "node-pty";
import sirv from "sirv";

import { startApiServer } from "./api-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appIconPath = path.join(__dirname, "..", "public", "icon.png");

const isDevelopment = process.env.NODE_ENV === "development";
const internalRendererPort = Number(process.env.ELECTRON_INTERNAL_PORT ?? 3210);
const rendererUrlFromEnv = process.env.ELECTRON_RENDERER_URL?.trim();
const developmentRendererUrl =
  rendererUrlFromEnv || `http://127.0.0.1:${internalRendererPort}`;
const apiServerPort = Number(process.env.ELECTRON_API_PORT ?? 3211);
const rendererStartupTimeoutMs = Number(
  process.env.VITE_READY_TIMEOUT_MS ?? 45000,
);
const rendererProbeIntervalMs = 300;

const DEFAULT_PERSISTED_STATE = {
  activeProjectId: null,
  activeThreadIdByProject: {},
  chats: {},
  panelVisibility: {
    left: true,
    middle: true,
    right: true,
  },
  projects: [],
  settings: {
    anthropicAccessToken: "",
    anthropicAccessTokenExpiresAt: null,
    anthropicAuthMode: "apiKey",
    anthropicApiKey: "",
    anthropicRefreshToken: "",
    anthropicSelectedModels: [],
    connectedProviders: [],
    defaultAnthropicModel: "",
    defaultOpenAiModel: "",
    openAiAuthMode: "apiKey",
    openAiApiKey: "",
    openAiSelectedModels: [],
    shellPath: "",
  },
  threadSort: "recent",
  threads: [],
};
const PERSISTED_STATE_KEY = "ide-state";
const LEGACY_STORE_FILENAME = "dream-settings.json";
const SQLITE_STATE_FILENAME = "dream.sqlite";

const legacyStore = new Store({
  defaults: DEFAULT_PERSISTED_STATE,
  name: "dream-settings",
});
let stateDatabase = null;

function cloneDefaultPersistedState() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSISTED_STATE));
}

function getLegacyStorePath() {
  return path.join(app.getPath("userData"), LEGACY_STORE_FILENAME);
}

function getStateDatabase() {
  if (stateDatabase) {
    return stateDatabase;
  }

  const databasePath = path.join(
    app.getPath("userData"),
    SQLITE_STATE_FILENAME,
  );
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `
        INSERT INTO app_meta (key, value)
        VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING
      `,
    )
    .run();
  stateDatabase = database;
  return database;
}

function readAppMeta(database, key) {
  const row = database
    .prepare("SELECT value FROM app_meta WHERE key = ?")
    .get(key);
  return typeof row?.value === "string" ? row.value : null;
}

function writeAppMeta(database, key, value) {
  database
    .prepare(
      `
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    )
    .run(key, value);
}

function readLegacyPersistedState() {
  try {
    const legacyState = legacyStore.store;
    if (legacyState && typeof legacyState === "object") {
      return legacyState;
    }
  } catch {
    // ignore legacy read failures
  }

  return cloneDefaultPersistedState();
}

function getLegacyStoreUpdatedAt() {
  try {
    const legacyStorePath = getLegacyStorePath();
    if (!existsSync(legacyStorePath)) {
      return null;
    }

    return statSync(legacyStorePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function savePersistedState(state) {
  if (!state || typeof state !== "object") {
    return false;
  }

  const database = getStateDatabase();
  database
    .prepare(
      `
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .run(PERSISTED_STATE_KEY, JSON.stringify(state), new Date().toISOString());
  return true;
}

function syncLegacyPersistedState(database) {
  const legacyState = readLegacyPersistedState();
  savePersistedState(legacyState);
  writeAppMeta(
    database,
    "legacy_store_synced_at",
    getLegacyStoreUpdatedAt() ?? new Date().toISOString(),
  );
  return legacyState;
}

function loadPersistedState() {
  const database = getStateDatabase();
  const row = database
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(PERSISTED_STATE_KEY);
  const legacyStoreUpdatedAt = getLegacyStoreUpdatedAt();
  const legacyStoreSyncedAt = readAppMeta(database, "legacy_store_synced_at");

  if (typeof row?.value === "string" && row.value.trim()) {
    try {
      const persistedState = JSON.parse(row.value);
      if (persistedState && typeof persistedState === "object") {
        if (
          legacyStoreUpdatedAt &&
          (!legacyStoreSyncedAt || legacyStoreUpdatedAt > legacyStoreSyncedAt)
        ) {
          return syncLegacyPersistedState(database);
        }

        return persistedState;
      }
    } catch {
      // ignore invalid sqlite payloads and fall through to migration
    }
  }

  return syncLegacyPersistedState(database);
}

let mainWindow = null;
let activePreviewProjectId = null;
const previewSessions = new Map();

let rendererUrl = developmentRendererUrl;
let viteDevProcess = null;
let productionHttpServer = null;

const runProcesses = new Map();
const terminalSessions = new Map();
const terminalTransports = new Map();
const terminalShells = new Map();

const previewState = {
  bounds: { height: 0, width: 0, x: 0, y: 0 },
  projectId: null,
  reload: false,
  visible: false,
  url: "about:blank",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

function getAlternateLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }

    if (host === "127.0.0.1") {
      parsed.hostname = "localhost";
      return parsed.toString();
    }
  } catch {
    // ignore parse failures
  }

  return null;
}

function getPreviewLoadCandidates(value) {
  const primary = value.trim();
  const alternate = getAlternateLoopbackUrl(primary);

  if (!alternate || alternate === primary) {
    return [primary];
  }

  return [primary, alternate];
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
  const rendererOrigin = getUrlOrigin(rendererUrl);

  if (!targetOrigin || !rendererOrigin) {
    return false;
  }

  return targetOrigin === rendererOrigin;
}

function parseCommandParts(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const parts = matches.map((part) =>
    part.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"),
  );
  const command = parts[0];
  if (!command) {
    return null;
  }

  return {
    args: parts.slice(1),
    command,
  };
}

function formatShellCommand(command, args = []) {
  const trimmedCommand = typeof command === "string" ? command.trim() : "";
  if (!trimmedCommand) {
    return "";
  }

  const normalizedArgs = Array.isArray(args)
    ? args
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  return [trimmedCommand, ...normalizedArgs].join(" ");
}

function resolveTerminalCwd(cwd) {
  if (typeof cwd !== "string") {
    return app.getPath("home");
  }

  const trimmed = cwd.trim();
  if (!trimmed) {
    return app.getPath("home");
  }

  try {
    if (existsSync(trimmed) && statSync(trimmed).isDirectory()) {
      return trimmed;
    }
  } catch {
    // ignore and fall back
  }

  return app.getPath("home");
}

function buildTerminalShellCandidates(preferredShellPath) {
  const defaultShellArgs = process.platform === "win32" ? [] : ["-il"];
  const candidates = [];
  const seen = new Set();

  const addCandidate = (rawValue, label) => {
    const parsed = parseCommandParts(rawValue);
    if (!parsed) {
      return;
    }

    const args = parsed.args.length > 0 ? parsed.args : defaultShellArgs;
    const key = `${parsed.command}\u0000${args.join("\u0000")}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({
      args,
      command: parsed.command,
      label,
    });
  };

  addCandidate(preferredShellPath, "configured shell");
  addCandidate(process.env.SHELL, "SHELL environment");

  if (process.platform === "win32") {
    addCandidate("powershell.exe", "PowerShell fallback");
    addCandidate("cmd.exe", "CMD fallback");
  } else if (process.platform === "darwin") {
    addCandidate("/bin/zsh", "macOS zsh fallback");
    addCandidate("/bin/bash", "bash fallback");
    addCandidate("/bin/sh", "sh fallback");
  } else {
    addCandidate("/bin/bash", "bash fallback");
    addCandidate("/bin/sh", "sh fallback");
  }

  return candidates;
}

function getPipeFallbackShell() {
  if (process.platform === "win32") {
    return {
      args: [],
      command: "powershell.exe",
      label: "PowerShell pipe fallback",
    };
  }

  if (existsSync("/bin/bash")) {
    return {
      args: ["--noprofile", "--norc", "-i"],
      command: "/bin/bash",
      label: "bash pipe fallback",
    };
  }

  return {
    args: ["-i"],
    command: "/bin/sh",
    label: "sh pipe fallback",
  };
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

function createPreviewSession(projectId) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  view.webContents.on("did-start-loading", () => {
    sendToRenderer("preview:status", {
      loading: true,
      projectId,
    });
  });

  view.webContents.on("did-finish-load", () => {
    const session = previewSessions.get(projectId);
    if (session) {
      session.loadingRequestedUrl = null;
      session.currentLoadedUrl =
        session.view.webContents.getURL() || "about:blank";
    }
  });

  view.webContents.on("did-stop-loading", () => {
    const session = previewSessions.get(projectId);
    if (session && session.view.webContents.getURL() !== "about:blank") {
      session.loadingRequestedUrl = null;
      session.currentLoadedUrl = session.view.webContents.getURL();
    }

    sendToRenderer("preview:status", {
      loading: false,
      projectId,
    });
  });

  view.webContents.on(
    "did-fail-load",
    (_event, code, description, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      const session = previewSessions.get(projectId);
      if (session) {
        session.currentLoadedUrl = "about:blank";
        session.loadingRequestedUrl = null;
      }

      view.webContents.loadURL("about:blank").catch(() => {});

      if (previewState.projectId !== projectId) {
        return;
      }

      sendToRenderer("preview:error", {
        code,
        description,
      });
    },
  );

  return {
    attached: false,
    currentLoadedUrl: "about:blank",
    currentRequestedUrl: "about:blank",
    loadRequestId: 0,
    loadingRequestedUrl: null,
    projectId,
    view,
  };
}

function getPreviewSession(projectId) {
  const normalizedProjectId =
    typeof projectId === "string" ? projectId.trim() : "";
  if (!normalizedProjectId) {
    return null;
  }

  const existing = previewSessions.get(normalizedProjectId);
  if (existing) {
    return existing;
  }

  const created = createPreviewSession(normalizedProjectId);
  previewSessions.set(normalizedProjectId, created);
  return created;
}

function attachPreviewSession(session) {
  if (!mainWindow || mainWindow.isDestroyed() || !session) {
    return;
  }

  if (session.attached) {
    return;
  }

  mainWindow.contentView.addChildView(session.view);
  session.attached = true;
}

function detachPreviewSession(session) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !session ||
    !session.attached
  ) {
    return;
  }

  mainWindow.contentView.removeChildView(session.view);
  session.attached = false;
}

function detachAllPreviewSessions() {
  for (const session of previewSessions.values()) {
    detachPreviewSession(session);
  }
}

function stopPreviewNavigation(projectId) {
  const session = getPreviewSession(projectId);
  if (!session) {
    return;
  }

  session.loadRequestId += 1;
  session.loadingRequestedUrl = null;
  session.currentRequestedUrl = session.currentLoadedUrl || "about:blank";

  try {
    session.view.webContents.stop();
  } catch {
    // ignore stop failures
  }

  sendToRenderer("preview:status", {
    loading: false,
    projectId: session.projectId,
  });
}

function applyPreviewState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const { bounds, projectId, url, visible } = previewState;
  const canRender =
    visible &&
    typeof projectId === "string" &&
    projectId.trim().length > 0 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    isHttpUrl(url);

  if (!canRender) {
    if (activePreviewProjectId) {
      const activeSession = previewSessions.get(activePreviewProjectId);
      if (activeSession) {
        detachPreviewSession(activeSession);
      }
    }
    if (typeof projectId === "string" && projectId.trim().length > 0) {
      sendToRenderer("preview:status", {
        loading: false,
        projectId,
      });
    }
    activePreviewProjectId = null;
    return;
  }

  const nextSession = getPreviewSession(projectId);
  if (!nextSession) {
    return;
  }

  if (
    activePreviewProjectId &&
    activePreviewProjectId !== nextSession.projectId
  ) {
    const previousSession = previewSessions.get(activePreviewProjectId);
    if (previousSession) {
      detachPreviewSession(previousSession);
    }
  }

  activePreviewProjectId = nextSession.projectId;
  attachPreviewSession(nextSession);

  nextSession.view.setBounds({
    height: Math.round(bounds.height),
    width: Math.round(bounds.width),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  });

  const forceReload = previewState.reload;
  previewState.reload = false;

  if (
    (!forceReload && nextSession.currentRequestedUrl === url) ||
    nextSession.loadingRequestedUrl === url
  ) {
    return;
  }

  if (
    forceReload &&
    nextSession.currentRequestedUrl === url &&
    nextSession.currentLoadedUrl !== "about:blank" &&
    !nextSession.loadingRequestedUrl
  ) {
    nextSession.loadingRequestedUrl = url;

    try {
      nextSession.view.webContents.reloadIgnoringCache();
    } catch (error) {
      nextSession.loadingRequestedUrl = null;
      sendToRenderer("preview:error", {
        code: "RELOAD_FAILED",
        description: error instanceof Error ? error.message : "Unknown error",
      });
      sendToRenderer("preview:status", {
        loading: false,
        projectId: nextSession.projectId,
      });
    }

    return;
  }

  nextSession.currentRequestedUrl = url;
  nextSession.loadingRequestedUrl = url;
  const requestId = ++nextSession.loadRequestId;
  const candidates = getPreviewLoadCandidates(url);

  const loadCandidate = async (index = 0) => {
    if (requestId !== nextSession.loadRequestId) {
      return;
    }

    const candidate = candidates[index];
    if (!candidate) {
      if (requestId !== nextSession.loadRequestId) {
        return;
      }

      nextSession.loadingRequestedUrl = null;
      nextSession.currentRequestedUrl = "about:blank";
      nextSession.currentLoadedUrl = "about:blank";
      nextSession.view.webContents.loadURL("about:blank").catch(() => {});

      if (previewState.projectId === nextSession.projectId) {
        sendToRenderer("preview:error", {
          code: "LOAD_URL_FAILED",
          description: "Failed to load preview URL.",
        });
      }

      return;
    }

    try {
      await nextSession.view.webContents.loadURL(candidate);

      if (requestId !== nextSession.loadRequestId) {
        return;
      }

      nextSession.loadingRequestedUrl = null;
      nextSession.currentLoadedUrl = candidate;
    } catch (error) {
      if (requestId !== nextSession.loadRequestId) {
        return;
      }

      if (index + 1 < candidates.length) {
        await loadCandidate(index + 1);
        return;
      }

      nextSession.loadingRequestedUrl = null;
      nextSession.currentRequestedUrl = "about:blank";
      nextSession.currentLoadedUrl = "about:blank";
      nextSession.view.webContents.loadURL("about:blank").catch(() => {});

      if (previewState.projectId === nextSession.projectId) {
        sendToRenderer("preview:error", {
          code: "LOAD_URL_FAILED",
          description: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  };

  void loadCandidate();
}

function stopChildProcess(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === "win32") {
    spawnProcess("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
      stdio: "ignore",
    });
    return;
  }

  child.kill("SIGTERM");
}

function stopRunProcess(projectId) {
  const child = runProcesses.get(projectId);
  if (!child) {
    return;
  }

  stopChildProcess(child);
  runProcesses.delete(projectId);
  sendToRenderer("runner:status", {
    projectId,
    status: "stopped",
  });
}

function stopTerminalSession(projectId) {
  const session = terminalSessions.get(projectId);
  const transport = terminalTransports.get(projectId);
  const shell = terminalShells.get(projectId);
  if (!session) {
    return;
  }

  try {
    session.kill();
  } catch {
    // ignore
  }
  terminalSessions.delete(projectId);
  terminalTransports.delete(projectId);
  terminalShells.delete(projectId);
  sendToRenderer("terminal:status", {
    projectId,
    shell,
    status: "stopped",
    transport,
  });
}

function stopAllProcesses() {
  for (const projectId of runProcesses.keys()) {
    stopRunProcess(projectId);
  }

  for (const projectId of terminalSessions.keys()) {
    stopTerminalSession(projectId);
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

async function startRendererServerIfNeeded() {
  // Always start the API server (Hono) on the API port
  await startApiServer(apiServerPort);

  if (isDevelopment) {
    rendererUrl = developmentRendererUrl;

    if (rendererUrlFromEnv) {
      return;
    }

    const projectRoot = path.resolve(__dirname, "..");
    const viteCli = path.join(
      projectRoot,
      "node_modules",
      "vite",
      "bin",
      "vite.js",
    );

    viteDevProcess = spawnProcess(
      process.execPath,
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

  // Production: serve Vite build output with sirv + proxy /api to Hono
  const appPath = app.getAppPath();
  const distPath = path.join(appPath, "dist");
  const sirvHandler = sirv(distPath, {
    single: true,
    dev: false,
  });

  productionHttpServer = http.createServer((request, response) => {
    // Proxy /api requests to the Hono API server
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

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: "#f8fafc",
    height: 1080,
    minHeight: 720,
    minWidth: 1180,
    icon:
      process.platform === "darwin" || !existsSync(appIconPath)
        ? undefined
        : appIconPath,
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
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isRendererNavigation(url)) {
      return;
    }

    event.preventDefault();

    if (isHttpUrl(url)) {
      shell.openExternal(url);
    }
  });

  mainWindow.on("resize", () => {
    applyPreviewState();
  });

  mainWindow.on("closed", () => {
    detachAllPreviewSessions();
    activePreviewProjectId = null;
    previewState.projectId = null;
    mainWindow = null;
  });

  await configureRendererProxy(mainWindow.webContents);

  mainWindow.loadURL(rendererUrl).catch((error) => {
    console.error("Failed to load renderer:", error);
  });
}

ipcMain.handle("projects:pick-directory", pickDirectory);
ipcMain.handle("state:load", () => loadPersistedState());

ipcMain.handle("state:save", (_event, state) => savePersistedState(state));

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

ipcMain.handle(
  "runner:start",
  (_event, { command, cwd, projectId, projectName }) => {
    if (!projectId || !cwd || !command) {
      throw new Error("Missing runner parameters.");
    }

    stopRunProcess(projectId);

    const child = spawnProcess(command, {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "1",
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    runProcesses.set(projectId, child);

    sendToRenderer("runner:status", {
      pid: child.pid,
      projectId,
      projectName,
      status: "running",
    });

    child.stdout?.on("data", (chunk) => {
      sendToRenderer("runner:data", {
        chunk: chunk.toString(),
        projectId,
        stream: "stdout",
      });
    });

    child.stderr?.on("data", (chunk) => {
      sendToRenderer("runner:data", {
        chunk: chunk.toString(),
        projectId,
        stream: "stderr",
      });
    });

    child.on("close", (code, signal) => {
      runProcesses.delete(projectId);
      sendToRenderer("runner:status", {
        code,
        projectId,
        signal,
        status: "stopped",
      });
    });

    child.on("error", (error) => {
      sendToRenderer("runner:data", {
        chunk: `[runner error] ${error.message}\n`,
        projectId,
        stream: "stderr",
      });
    });

    return { pid: child.pid, status: "running" };
  },
);

ipcMain.handle("runner:stop", (_event, { projectId }) => {
  if (!projectId) {
    return false;
  }

  stopRunProcess(projectId);
  return true;
});

ipcMain.handle(
  "terminal:start",
  (_event, { command, cwd, projectId, shellPath: preferredShellPath }) => {
    if (!projectId || !cwd) {
      throw new Error("Missing terminal parameters.");
    }

    stopTerminalSession(projectId);

    const shellCandidates = buildTerminalShellCandidates(preferredShellPath);
    const resolvedCwd = resolveTerminalCwd(cwd);

    if (resolvedCwd !== cwd) {
      sendToRenderer("terminal:data", {
        chunk: `\r\n\u001b[33m[terminal warning] CWD not found: ${cwd}. Using ${resolvedCwd}.\u001b[0m\r\n`,
        projectId,
      });
    }

    let terminalSession;
    let chosenShell = null;
    const spawnErrors = [];

    for (const candidate of shellCandidates) {
      try {
        terminalSession = spawnPty(candidate.command, candidate.args, {
          cols: 120,
          cwd: resolvedCwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
          },
          name: "xterm-256color",
          rows: 36,
        });
        chosenShell = candidate;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spawnErrors.push(
          `${candidate.command} (${candidate.label}): ${message}`,
        );
      }
    }

    if (!terminalSession || !chosenShell) {
      const pipeFallbackCandidate = getPipeFallbackShell();

      let child;
      try {
        child = spawnProcess(
          pipeFallbackCandidate.command,
          pipeFallbackCandidate.args,
          {
            cwd: resolvedCwd,
            env: {
              ...process.env,
              BASH_SILENCE_DEPRECATION_WARNING: "1",
              PS1: "\\u@\\h \\W $ ",
              TERM: "xterm-256color",
            },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spawnErrors.push(
          `${pipeFallbackCandidate.command} (${pipeFallbackCandidate.label}): ${message}`,
        );
        const detail =
          spawnErrors.length > 0 ? `\r\n${spawnErrors.join("\r\n")}` : "";
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] Unable to start shell.${detail}\r\n`,
          projectId,
        });
        sendToRenderer("terminal:status", {
          projectId,
          status: "stopped",
        });
        return { status: "stopped" };
      }

      if (typeof child.pid !== "number") {
        const detail =
          spawnErrors.length > 0 ? `\r\n${spawnErrors.join("\r\n")}` : "";
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] Shell started without a PID.${detail}\r\n`,
          projectId,
        });
        sendToRenderer("terminal:status", {
          projectId,
          status: "stopped",
        });
        return { status: "stopped" };
      }

      terminalSessions.set(projectId, {
        kill: () => stopChildProcess(child),
        write: (data) => {
          if (
            typeof data !== "string" ||
            !child.stdin ||
            child.stdin.destroyed ||
            child.stdin.writableEnded
          ) {
            return;
          }

          child.stdin.write(data);
        },
      });
      terminalTransports.set(projectId, "pipe");
      const shellCommand = formatShellCommand(
        pipeFallbackCandidate.command,
        pipeFallbackCandidate.args,
      );
      terminalShells.set(projectId, shellCommand);

      sendToRenderer("terminal:status", {
        pid: child.pid,
        projectId,
        shell: shellCommand,
        status: "running",
        transport: "pipe",
      });

      sendToRenderer("terminal:data", {
        chunk: `\u001b[2m[terminal started (pipe fallback): ${shellCommand}]\u001b[0m\r\n`,
        projectId,
      });

      if (spawnErrors.length > 0) {
        sendToRenderer("terminal:data", {
          chunk: `\u001b[2m[terminal info] PTY unavailable; using pipe fallback.\u001b[0m\r\n`,
          projectId,
        });
      }

      child.stdout?.on("data", (chunk) => {
        sendToRenderer("terminal:data", {
          chunk: chunk.toString(),
          projectId,
        });
      });

      child.stderr?.on("data", (chunk) => {
        sendToRenderer("terminal:data", {
          chunk: chunk.toString(),
          projectId,
        });
      });

      child.on("close", (code, signal) => {
        terminalSessions.delete(projectId);
        terminalTransports.delete(projectId);
        terminalShells.delete(projectId);
        sendToRenderer("terminal:status", {
          code,
          projectId,
          shell: shellCommand,
          signal,
          status: "stopped",
          transport: "pipe",
        });
      });

      child.on("error", (error) => {
        terminalSessions.delete(projectId);
        terminalTransports.delete(projectId);
        terminalShells.delete(projectId);
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] ${error.message}\r\n`,
          projectId,
        });
        sendToRenderer("terminal:status", {
          projectId,
          shell: shellCommand,
          status: "stopped",
          transport: "pipe",
        });
      });

      if (typeof command === "string" && command.trim()) {
        setTimeout(() => {
          const session = terminalSessions.get(projectId);
          if (!session) {
            return;
          }

          try {
            session.write(`${command.trim()}\r`);
          } catch {
            // ignore write failures after session exits
          }
        }, 80);
      }

      return {
        pid: child.pid,
        shell: shellCommand,
        status: "running",
        transport: "pipe",
      };
    }

    terminalSessions.set(projectId, terminalSession);
    terminalTransports.set(projectId, "pty");
    const shellCommand = formatShellCommand(
      chosenShell.command,
      chosenShell.args,
    );
    terminalShells.set(projectId, shellCommand);
    sendToRenderer("terminal:status", {
      pid: terminalSession.pid,
      projectId,
      shell: shellCommand,
      status: "running",
      transport: "pty",
    });

    sendToRenderer("terminal:data", {
      chunk: `\u001b[2m[terminal started: ${shellCommand}]\u001b[0m\r\n`,
      projectId,
    });

    terminalSession.onData((chunk) => {
      sendToRenderer("terminal:data", {
        chunk,
        projectId,
      });
    });

    terminalSession.onExit(({ exitCode, signal }) => {
      terminalSessions.delete(projectId);
      terminalTransports.delete(projectId);
      terminalShells.delete(projectId);
      sendToRenderer("terminal:status", {
        code: exitCode,
        projectId,
        shell: shellCommand,
        signal: signal ?? null,
        status: "stopped",
        transport: "pty",
      });
    });

    if (typeof command === "string" && command.trim()) {
      setTimeout(() => {
        const session = terminalSessions.get(projectId);
        if (!session) {
          return;
        }

        try {
          session.write(`${command.trim()}\r`);
        } catch {
          // ignore write failures after session exits
        }
      }, 80);
    }

    return {
      pid: terminalSession.pid,
      shell: shellCommand,
      status: "running",
      transport: "pty",
    };
  },
);

ipcMain.on("terminal:input", (_event, { data, projectId }) => {
  if (!projectId || typeof data !== "string") {
    return;
  }

  const session = terminalSessions.get(projectId);
  if (!session) {
    return;
  }

  try {
    session.write(data);
  } catch {
    // ignore write failures after process/session exits
  }
});

ipcMain.handle("terminal:stop", (_event, { projectId }) => {
  if (!projectId) {
    return false;
  }

  stopTerminalSession(projectId);
  return true;
});

ipcMain.on("preview:update", (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (
    typeof payload.projectId === "string" &&
    payload.projectId.trim().length > 0
  ) {
    previewState.projectId = payload.projectId.trim();
  }

  if (payload.stop === true) {
    stopPreviewNavigation(previewState.projectId);
    return;
  }

  const nextBounds = payload.bounds;
  if (nextBounds && typeof nextBounds === "object") {
    previewState.bounds = {
      height: Number(nextBounds.height ?? previewState.bounds.height),
      width: Number(nextBounds.width ?? previewState.bounds.width),
      x: Number(nextBounds.x ?? previewState.bounds.x),
      y: Number(nextBounds.y ?? previewState.bounds.y),
    };
  }

  if (typeof payload.visible === "boolean") {
    previewState.visible = payload.visible;
  }

  if (payload.reload === true) {
    previewState.reload = true;
  }

  if (typeof payload.url === "string" && payload.url.trim().length > 0) {
    previewState.url = payload.url.trim();
  }

  applyPreviewState();
});

app.whenReady().then(async () => {
  app.setName("Dream IDE");

  await startRendererServerIfNeeded();
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("before-quit", async () => {
  stopAllProcesses();

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

  if (stateDatabase) {
    stateDatabase.close();
    stateDatabase = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
