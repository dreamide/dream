import { spawn as spawnProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
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
import next from "next";
import { spawn as spawnPty } from "node-pty";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDevelopment = process.env.NODE_ENV === "development";
const developmentRendererUrl =
  process.env.ELECTRON_RENDERER_URL ?? "http://127.0.0.1:3210";
const internalRendererPort = Number(process.env.ELECTRON_INTERNAL_PORT ?? 3210);

const store = new Store({
  defaults: {
    activeProjectId: null,
    chats: {},
    panelVisibility: {
      bottom: true,
      left: true,
      middle: true,
      right: true,
    },
    projects: [],
    settings: {
      anthropicApiKey: "",
      defaultAnthropicModel: "claude-3-7-sonnet-latest",
      defaultOpenAiModel: "gpt-4.1-mini",
      openAiAuthMode: "apiKey",
      openAiApiKey: "",
      shellPath: "",
    },
  },
  name: "dream-settings",
});

let mainWindow = null;
let previewView = null;
let previewAttached = false;

let rendererUrl = developmentRendererUrl;
let nextAppServer = null;
let nextHttpServer = null;

const runProcesses = new Map();
const terminalSessions = new Map();
const terminalTransports = new Map();

const previewState = {
  bounds: { height: 0, width: 0, x: 0, y: 0 },
  currentLoadedUrl: "about:blank",
  visible: false,
  url: "about:blank",
};

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
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

function ensurePreviewView() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  if (!previewView) {
    previewView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
      },
    });

    previewView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    previewView.webContents.on("did-fail-load", (_event, code, description) => {
      sendToRenderer("preview:error", {
        code,
        description,
      });
    });
  }

  return previewView;
}

function attachPreviewIfNeeded() {
  const view = ensurePreviewView();
  if (!mainWindow || !view) {
    return;
  }

  if (!previewAttached) {
    mainWindow.contentView.addChildView(view);
    previewAttached = true;
  }
}

function detachPreviewIfNeeded() {
  if (!mainWindow || !previewView || !previewAttached) {
    return;
  }

  mainWindow.contentView.removeChildView(previewView);
  previewAttached = false;
}

function applyPreviewState() {
  const view = ensurePreviewView();
  if (!mainWindow || !view) {
    return;
  }

  const { bounds, url, visible } = previewState;
  const canRender =
    visible && bounds.width > 0 && bounds.height > 0 && isHttpUrl(url);

  if (!canRender) {
    detachPreviewIfNeeded();
    return;
  }

  attachPreviewIfNeeded();

  view.setBounds({
    height: Math.round(bounds.height),
    width: Math.round(bounds.width),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  });

  if (previewState.currentLoadedUrl !== url) {
    previewState.currentLoadedUrl = url;
    view.webContents.loadURL(url).catch((error) => {
      sendToRenderer("preview:error", {
        code: "LOAD_URL_FAILED",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    });
  }
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
  sendToRenderer("terminal:status", {
    projectId,
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
  if (isDevelopment) {
    rendererUrl = developmentRendererUrl;
    return;
  }

  const appPath = app.getAppPath();
  nextAppServer = next({
    dev: false,
    dir: appPath,
  });

  await nextAppServer.prepare();
  const handle = nextAppServer.getRequestHandler();

  nextHttpServer = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error("Failed to serve Next request:", error);
      response.statusCode = 500;
      response.end("Renderer server error");
    });
  });

  await new Promise((resolve, reject) => {
    nextHttpServer.once("error", reject);
    nextHttpServer.listen(internalRendererPort, "127.0.0.1", resolve);
  });

  rendererUrl = `http://127.0.0.1:${internalRendererPort}`;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: "#f8fafc",
    height: 980,
    minHeight: 720,
    minWidth: 1180,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      process.platform === "darwin"
        ? undefined
        : {
            color: "#f8fafc",
            height: 42,
            symbolColor: "#0f172a",
          },
    trafficLightPosition:
      process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      spellcheck: false,
    },
    width: 1680,
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
    mainWindow = null;
    detachPreviewIfNeeded();
  });

  await configureRendererProxy(mainWindow.webContents);

  mainWindow.loadURL(rendererUrl).catch((error) => {
    console.error("Failed to load renderer:", error);
  });
}

ipcMain.handle("projects:pick-directory", pickDirectory);

ipcMain.handle("state:load", () => store.store);

ipcMain.handle("state:save", (_event, state) => {
  if (!state || typeof state !== "object") {
    return false;
  }

  store.set(state);
  return true;
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
  (_event, { cwd, projectId, shellPath: preferredShellPath }) => {
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

      sendToRenderer("terminal:status", {
        pid: child.pid,
        projectId,
        status: "running",
        transport: "pipe",
      });

      const shellArgsText = pipeFallbackCandidate.args.join(" ");
      sendToRenderer("terminal:data", {
        chunk: `\u001b[2m[terminal started (pipe fallback): ${pipeFallbackCandidate.command}${shellArgsText ? ` ${shellArgsText}` : ""}]\u001b[0m\r\n`,
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
        sendToRenderer("terminal:status", {
          code,
          projectId,
          signal,
          status: "stopped",
          transport: "pipe",
        });
      });

      child.on("error", (error) => {
        terminalSessions.delete(projectId);
        terminalTransports.delete(projectId);
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] ${error.message}\r\n`,
          projectId,
        });
        sendToRenderer("terminal:status", {
          projectId,
          status: "stopped",
          transport: "pipe",
        });
      });

      return { pid: child.pid, status: "running", transport: "pipe" };
    }

    terminalSessions.set(projectId, terminalSession);
    terminalTransports.set(projectId, "pty");
    sendToRenderer("terminal:status", {
      pid: terminalSession.pid,
      projectId,
      status: "running",
      transport: "pty",
    });

    sendToRenderer("terminal:data", {
      chunk: `\u001b[2m[terminal started: ${chosenShell.command} ${chosenShell.args.join(" ")}]\u001b[0m\r\n`,
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
      sendToRenderer("terminal:status", {
        code: exitCode,
        projectId,
        signal: signal ?? null,
        status: "stopped",
        transport: "pty",
      });
    });

    return { pid: terminalSession.pid, status: "running", transport: "pty" };
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

  if (nextHttpServer) {
    await new Promise((resolve) => {
      nextHttpServer.close(() => resolve(undefined));
    });
    nextHttpServer = null;
  }

  if (nextAppServer) {
    await nextAppServer.close();
    nextAppServer = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
