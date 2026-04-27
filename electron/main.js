import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  WebContentsView,
} from "electron";
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
const APP_NAME = "Dream";
const APP_USER_DATA_PATH = path.join(app.getPath("appData"), APP_NAME);
const WINDOWS_POWERSHELL_PATH =
  process.platform === "win32"
    ? path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : null;
const WINDOWS_CMD_PATH =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
    : null;

app.setName(APP_NAME);
app.setPath("userData", APP_USER_DATA_PATH);

const DEFAULT_PERSISTED_STATE = {
  activeProjectId: null,
  activeChatIdByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  panelSizes: {
    leftSidebarWidth: 240,
    rightPanelWidth: 520,
    terminalHeight: 260,
  },
  panelVisibility: {
    left: true,
    middle: true,
    right: true,
  },
  projects: [],
  settings: {
    anthropicSelectedModels: [],
    defaultModel: "",
    expandEditToolParts: false,
    expandShellToolParts: false,
    openAiSelectedModels: [],
    showReasoningSummaries: true,
    shellPath: "",
  },
  chatSort: "recent",
};
const RELATIONAL_SCHEMA_VERSION = 2;
const SQLITE_STATE_FILENAME = "dream.sqlite";
let stateDatabase = null;

function cloneDefaultPersistedState() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSISTED_STATE));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJson(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeProjectPathKey(projectPath) {
  const trimmed = typeof projectPath === "string" ? projectPath.trim() : "";
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "") || trimmed;
  const normalized = withoutTrailingSeparators.replace(/\\/g, "/");
  const isWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || trimmed.includes("\\");

  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

function getProjectName(projectPath) {
  const pathParts = String(projectPath || "")
    .split(/[\\/]/)
    .filter(Boolean);

  return pathParts.at(-1) || "project";
}

function getMetadataObject(value) {
  if (isRecord(value)) {
    return { ...value };
  }

  if (typeof value === "string") {
    const parsed = parseJson(value, {});
    if (isRecord(parsed)) {
      return parsed;
    }
  }

  return {};
}

function getNestedRecord(parent, key) {
  return isRecord(parent?.[key]) ? parent[key] : {};
}

function getNestedString(parent, key, fallback = "") {
  return typeof parent?.[key] === "string" ? parent[key] : fallback;
}

function getNestedNullableString(parent, key) {
  return typeof parent?.[key] === "string" && parent[key].trim()
    ? parent[key]
    : null;
}

function getNestedNumber(parent, key, fallback) {
  return typeof parent?.[key] === "number" && Number.isFinite(parent[key])
    ? parent[key]
    : fallback;
}

function getNestedBoolean(parent, key, fallback) {
  return typeof parent?.[key] === "boolean" ? parent[key] : fallback;
}

function runInTransaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readConfig(database) {
  const rows = database.prepare("SELECT key, value FROM config").all();
  const config = {};

  for (const row of rows) {
    if (typeof row?.key === "string") {
      config[row.key] = parseJson(row.value, null);
    }
  }

  return config;
}

function writeConfig(database, key, value, updatedAt) {
  database
    .prepare(
      `
        INSERT INTO config (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .run(key, toJson(value), updatedAt);
}

function buildProjectMetadata(project, state, activeChatIdByProject) {
  const metadata = getMetadataObject(project.metadata);
  const modelSelection = {
    ...getNestedRecord(metadata, "modelSelection"),
    model: typeof project.model === "string" ? project.model : "",
    provider:
      typeof project.provider === "string" ? project.provider : "openai",
    reasoningEffort:
      typeof project.reasoningEffort === "string"
        ? project.reasoningEffort
        : "medium",
  };
  const browser = {
    ...getNestedRecord(metadata, "browser"),
    url:
      typeof project.browserUrl === "string"
        ? project.browserUrl
        : "http://127.0.0.1:3000",
  };
  const ui = {
    ...getNestedRecord(metadata, "ui"),
    activeChatId: activeChatIdByProject?.[project.id] ?? null,
  };

  if (project.id === state.activeProjectId) {
    ui.panelVisibility = {
      left: getNestedBoolean(state.panelVisibility, "left", true),
      middle: true,
      right: getNestedBoolean(state.panelVisibility, "right", true),
    };
    ui.panelSizes = {
      leftSidebarWidth: getNestedNumber(
        state.panelSizes,
        "leftSidebarWidth",
        240,
      ),
      rightPanelWidth: getNestedNumber(
        state.panelSizes,
        "rightPanelWidth",
        520,
      ),
      terminalHeight: getNestedNumber(state.panelSizes, "terminalHeight", 260),
    };
  }

  return {
    ...metadata,
    browser,
    modelSelection,
    runCommand:
      typeof project.runCommand === "string" ? project.runCommand : "pnpm dev",
    ui,
  };
}

function buildChatMetadata(chat) {
  const metadata = getMetadataObject(chat.metadata);
  const remoteConversation = {
    ...getNestedRecord(metadata, "remoteConversation"),
    id:
      typeof chat.remoteConversationId === "string" &&
      chat.remoteConversationId.trim()
        ? chat.remoteConversationId
        : null,
    model:
      typeof chat.remoteConversationModel === "string" &&
      chat.remoteConversationModel.trim()
        ? chat.remoteConversationModel
        : null,
    projectPath:
      typeof chat.remoteConversationProjectPath === "string" &&
      chat.remoteConversationProjectPath.trim()
        ? chat.remoteConversationProjectPath
        : null,
  };
  const modelSelection = {
    ...getNestedRecord(metadata, "modelSelection"),
    model: typeof chat.model === "string" ? chat.model : "",
    provider: typeof chat.provider === "string" ? chat.provider : "openai",
    reasoningEffort:
      typeof chat.reasoningEffort === "string"
        ? chat.reasoningEffort
        : "medium",
  };

  return {
    ...metadata,
    modelSelection,
    remoteConversation,
  };
}

function saveStateToRelationalDatabase(database, state) {
  if (!state || typeof state !== "object") {
    return false;
  }

  const now = new Date().toISOString();

  return runInTransaction(database, () => {
    const existingProjectCreatedAt = new Map(
      database
        .prepare("SELECT id, created_at FROM projects")
        .all()
        .map((row) => [row.id, row.created_at]),
    );
    const existingChatCreatedAt = new Map(
      database
        .prepare("SELECT id, created_at FROM chats")
        .all()
        .map((row) => [row.id, row.created_at]),
    );

    database.prepare("DELETE FROM chat_messages").run();
    database.prepare("DELETE FROM chats").run();
    database.prepare("DELETE FROM projects").run();
    database.prepare("DELETE FROM config").run();

    const settings = isRecord(state.settings) ? state.settings : {};
    writeConfig(
      database,
      "activeProjectId",
      state.activeProjectId ?? null,
      now,
    );
    writeConfig(database, "chatSort", state.chatSort ?? "recent", now);
    writeConfig(
      database,
      "settings.defaultModel",
      settings.defaultModel ?? "",
      now,
    );
    writeConfig(
      database,
      "settings.openAiSelectedModels",
      Array.isArray(settings.openAiSelectedModels)
        ? settings.openAiSelectedModels
        : [],
      now,
    );
    writeConfig(
      database,
      "settings.anthropicSelectedModels",
      Array.isArray(settings.anthropicSelectedModels)
        ? settings.anthropicSelectedModels
        : [],
      now,
    );
    writeConfig(database, "settings.shellPath", settings.shellPath ?? "", now);
    writeConfig(
      database,
      "settings.expandEditToolParts",
      settings.expandEditToolParts ?? false,
      now,
    );
    writeConfig(
      database,
      "settings.expandShellToolParts",
      settings.expandShellToolParts ?? false,
      now,
    );
    writeConfig(
      database,
      "settings.showReasoningSummaries",
      settings.showReasoningSummaries ?? true,
      now,
    );

    const activeChatIdByProject = isRecord(state.activeChatIdByProject)
      ? state.activeChatIdByProject
      : {};
    const rawProjects = Array.isArray(state.projects) ? state.projects : [];
    const rawClosedProjects = Array.isArray(state.closedProjects)
      ? state.closedProjects
      : [];
    const projectsToPersist = [];
    const seenProjectIds = new Set();
    const seenProjectPaths = new Set();

    for (const [status, projects] of [
      ["open", rawProjects],
      ["closed", rawClosedProjects],
    ]) {
      for (const project of projects) {
        if (!isRecord(project) || typeof project.id !== "string") {
          continue;
        }

        const normalizedPath = normalizeProjectPathKey(project.path);
        if (
          !project.id.trim() ||
          seenProjectIds.has(project.id) ||
          seenProjectPaths.has(normalizedPath)
        ) {
          continue;
        }

        seenProjectIds.add(project.id);
        seenProjectPaths.add(normalizedPath);
        projectsToPersist.push({ project, status });
      }
    }

    const insertProject = database.prepare(
      `
        INSERT INTO projects (
          id,
          path,
          normalized_path,
          name,
          status,
          sort_order,
          metadata,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    projectsToPersist.forEach(({ project, status }, index) => {
      const projectPath = typeof project.path === "string" ? project.path : "";
      const metadata = buildProjectMetadata(
        project,
        state,
        activeChatIdByProject,
      );

      insertProject.run(
        project.id,
        projectPath,
        normalizeProjectPathKey(projectPath),
        typeof project.name === "string" && project.name.trim()
          ? project.name
          : getProjectName(projectPath),
        status,
        index,
        toJson(metadata),
        existingProjectCreatedAt.get(project.id) ?? now,
        now,
      );
    });

    const knownProjectIds = new Set(
      projectsToPersist.map(({ project }) => project.id),
    );
    const chats = Array.isArray(state.chats) ? state.chats : [];
    const messagesByChatId = isRecord(state.messagesByChatId)
      ? state.messagesByChatId
      : {};
    const insertChat = database.prepare(
      `
        INSERT INTO chats (
          id,
          project_id,
          title,
          metadata,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const insertMessage = database.prepare(
      `
        INSERT INTO chat_messages (
          id,
          chat_id,
          role,
          sort_order,
          payload,
          metadata,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const chat of chats) {
      if (
        !isRecord(chat) ||
        typeof chat.id !== "string" ||
        typeof chat.projectId !== "string" ||
        !knownProjectIds.has(chat.projectId)
      ) {
        continue;
      }

      const createdAt =
        typeof chat.createdAt === "string" && chat.createdAt.trim()
          ? chat.createdAt
          : (existingChatCreatedAt.get(chat.id) ?? now);
      const updatedAt =
        typeof chat.updatedAt === "string" && chat.updatedAt.trim()
          ? chat.updatedAt
          : createdAt;

      insertChat.run(
        chat.id,
        chat.projectId,
        typeof chat.title === "string" && chat.title.trim()
          ? chat.title
          : "New chat",
        toJson(buildChatMetadata(chat)),
        createdAt,
        updatedAt,
        typeof chat.deletedAt === "string" && chat.deletedAt.trim()
          ? chat.deletedAt
          : null,
      );

      const messages = Array.isArray(messagesByChatId[chat.id])
        ? messagesByChatId[chat.id]
        : [];

      messages.forEach((message, index) => {
        if (!isRecord(message)) {
          return;
        }

        const messageId =
          typeof message.id === "string" && message.id.trim()
            ? message.id
            : `message-${index}`;

        insertMessage.run(
          `${chat.id}:${index}:${messageId}`,
          chat.id,
          typeof message.role === "string" ? message.role : "",
          index,
          toJson(message),
          toJson({}),
          now,
        );
      });
    }

    database
      .prepare(
        `
          INSERT INTO schema_migrations (version, applied_at)
          VALUES (?, ?)
          ON CONFLICT(version) DO NOTHING
        `,
      )
      .run(RELATIONAL_SCHEMA_VERSION, now);
    return true;
  });
}

function loadStateFromRelationalDatabase(database) {
  const config = readConfig(database);
  const projectRows = database
    .prepare(
      `
        SELECT *
        FROM projects
        ORDER BY status = 'closed', sort_order, created_at
      `,
    )
    .all();

  if (projectRows.length === 0 && Object.keys(config).length === 0) {
    return cloneDefaultPersistedState();
  }

  const projects = [];
  const closedProjects = [];
  const allProjects = [];
  const activeChatIdByProject = {};
  const projectMetadataById = new Map();

  for (const row of projectRows) {
    const metadata = getMetadataObject(row.metadata);
    const modelSelection = getNestedRecord(metadata, "modelSelection");
    const browser = getNestedRecord(metadata, "browser");
    const ui = getNestedRecord(metadata, "ui");
    const project = {
      browserUrl: getNestedString(browser, "url", "http://127.0.0.1:3000"),
      id: row.id,
      metadata,
      model: getNestedString(modelSelection, "model", ""),
      name: row.name || getProjectName(row.path),
      path: row.path || "",
      provider: getNestedString(modelSelection, "provider", "openai"),
      reasoningEffort: getNestedString(
        modelSelection,
        "reasoningEffort",
        "medium",
      ),
      runCommand: getNestedString(metadata, "runCommand", "pnpm dev"),
    };

    projectMetadataById.set(row.id, metadata);
    activeChatIdByProject[row.id] = getNestedNullableString(ui, "activeChatId");
    allProjects.push(project);

    if (row.status === "closed") {
      closedProjects.push(project);
    } else {
      projects.push(project);
    }
  }

  const chats = [];
  const chatRows = database
    .prepare(
      `
        SELECT *
        FROM chats
        ORDER BY created_at, id
      `,
    )
    .all();

  for (const row of chatRows) {
    const metadata = getMetadataObject(row.metadata);
    const modelSelection = getNestedRecord(metadata, "modelSelection");
    const remoteConversation = getNestedRecord(metadata, "remoteConversation");

    chats.push({
      createdAt: row.created_at,
      deletedAt:
        typeof row.deleted_at === "string" && row.deleted_at.trim()
          ? row.deleted_at
          : null,
      id: row.id,
      metadata,
      model: getNestedString(modelSelection, "model", ""),
      projectId: row.project_id,
      provider: getNestedString(modelSelection, "provider", "openai"),
      reasoningEffort: getNestedString(
        modelSelection,
        "reasoningEffort",
        "medium",
      ),
      remoteConversationId: getNestedNullableString(remoteConversation, "id"),
      remoteConversationModel: getNestedNullableString(
        remoteConversation,
        "model",
      ),
      remoteConversationProjectPath: getNestedNullableString(
        remoteConversation,
        "projectPath",
      ),
      title: row.title || "New chat",
      updatedAt: row.updated_at,
    });
  }

  const messagesByChatId = Object.fromEntries(
    chats.map((chat) => [chat.id, []]),
  );
  const messageRows = database
    .prepare(
      `
        SELECT chat_id, payload
        FROM chat_messages
        ORDER BY chat_id, sort_order
      `,
    )
    .all();

  for (const row of messageRows) {
    const payload = parseJson(row.payload, null);
    if (isRecord(payload) && Array.isArray(messagesByChatId[row.chat_id])) {
      messagesByChatId[row.chat_id].push(payload);
    }
  }

  for (const project of allProjects) {
    const requestedChatId = activeChatIdByProject[project.id];
    const projectChats = chats.filter((chat) => chat.projectId === project.id);
    activeChatIdByProject[project.id] = projectChats.some(
      (chat) => chat.id === requestedChatId,
    )
      ? requestedChatId
      : (projectChats[0]?.id ?? null);
  }

  const activeProjectId =
    typeof config.activeProjectId === "string" ? config.activeProjectId : null;
  const activeProject =
    allProjects.find((project) => project.id === activeProjectId) ??
    projects[0] ??
    null;
  const activeProjectMetadata = activeProject
    ? projectMetadataById.get(activeProject.id)
    : null;
  const activeProjectUi = getNestedRecord(activeProjectMetadata, "ui");
  const panelVisibility = {
    left: getNestedBoolean(
      getNestedRecord(activeProjectUi, "panelVisibility"),
      "left",
      true,
    ),
    middle: true,
    right: getNestedBoolean(
      getNestedRecord(activeProjectUi, "panelVisibility"),
      "right",
      true,
    ),
  };
  const panelSizes = {
    leftSidebarWidth: getNestedNumber(
      getNestedRecord(activeProjectUi, "panelSizes"),
      "leftSidebarWidth",
      240,
    ),
    rightPanelWidth: getNestedNumber(
      getNestedRecord(activeProjectUi, "panelSizes"),
      "rightPanelWidth",
      520,
    ),
    terminalHeight: getNestedNumber(
      getNestedRecord(activeProjectUi, "panelSizes"),
      "terminalHeight",
      260,
    ),
  };

  return {
    activeProjectId,
    activeChatIdByProject,
    chats,
    chatSort: typeof config.chatSort === "string" ? config.chatSort : "recent",
    closedProjects,
    messagesByChatId,
    panelSizes,
    panelVisibility,
    projects,
    settings: {
      anthropicSelectedModels: Array.isArray(
        config["settings.anthropicSelectedModels"],
      )
        ? config["settings.anthropicSelectedModels"]
        : [],
      defaultModel:
        typeof config["settings.defaultModel"] === "string"
          ? config["settings.defaultModel"]
          : "",
      expandEditToolParts:
        typeof config["settings.expandEditToolParts"] === "boolean"
          ? config["settings.expandEditToolParts"]
          : false,
      expandShellToolParts:
        typeof config["settings.expandShellToolParts"] === "boolean"
          ? config["settings.expandShellToolParts"]
          : false,
      openAiSelectedModels: Array.isArray(
        config["settings.openAiSelectedModels"],
      )
        ? config["settings.openAiSelectedModels"]
        : [],
      showReasoningSummaries:
        typeof config["settings.showReasoningSummaries"] === "boolean"
          ? config["settings.showReasoningSummaries"]
          : true,
      shellPath:
        typeof config["settings.shellPath"] === "string"
          ? config["settings.shellPath"]
          : "",
    },
  };
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
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    DROP TABLE IF EXISTS app_state;
    DROP TABLE IF EXISTS app_meta;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL CHECK (json_valid(value)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      normalized_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_status_order
      ON projects(status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_order
      ON chat_messages(chat_id, sort_order);
  `);
  database.exec(`
    DROP INDEX IF EXISTS idx_chats_project_updated;
    CREATE INDEX IF NOT EXISTS idx_chats_project_updated
      ON chats(project_id, deleted_at, updated_at DESC);
  `);
  database
    .prepare(
      `
        INSERT INTO schema_migrations (version, applied_at)
        VALUES (?, ?)
        ON CONFLICT(version) DO NOTHING
      `,
    )
    .run(RELATIONAL_SCHEMA_VERSION, new Date().toISOString());
  stateDatabase = database;
  return database;
}

function savePersistedState(state) {
  const database = getStateDatabase();
  return saveStateToRelationalDatabase(database, state);
}

function loadPersistedState() {
  const database = getStateDatabase();
  return loadStateFromRelationalDatabase(database);
}

let mainWindow = null;
let activeBrowserTabId = null;
const browserSessions = new Map(); // keyed by tabId

let rendererUrl = developmentRendererUrl;
let viteDevProcess = null;
let productionHttpServer = null;

const runProcesses = new Map();
const terminalSessions = new Map();
const terminalTransports = new Map();
const terminalShells = new Map();

const browserState = {
  bounds: { height: 0, width: 0, x: 0, y: 0 },
  projectId: null,
  tabId: null,
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

function getBrowserLoadCandidates(value) {
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

function getBrowserPageState(session) {
  if (!session) {
    return null;
  }

  const { webContents } = session.view;
  const navigationHistory = webContents.navigationHistory;
  const currentUrl =
    session.failedRequestedUrl ||
    webContents.getURL() ||
    session.currentLoadedUrl ||
    session.currentRequestedUrl ||
    "about:blank";

  return {
    canGoBack: navigationHistory?.canGoBack() ?? false,
    canGoForward: navigationHistory?.canGoForward() ?? false,
    projectId: session.projectId,
    tabId: session.tabId,
    title: webContents.getTitle() || session.title || "New Tab",
    url: currentUrl,
  };
}

function sendBrowserPageState(session) {
  const pageState = getBrowserPageState(session);
  if (!pageState) {
    return;
  }

  sendToRenderer("browser:page-state", pageState);
}

function settleBrowserLoadFailure(session, failedUrl) {
  if (!session) {
    return;
  }

  const nextRequestedUrl =
    (typeof session.loadingRequestedUrl === "string" &&
    session.loadingRequestedUrl.trim().length > 0
      ? session.loadingRequestedUrl.trim()
      : null) ||
    (typeof session.currentRequestedUrl === "string" &&
    session.currentRequestedUrl.trim().length > 0
      ? session.currentRequestedUrl.trim()
      : null) ||
    (typeof failedUrl === "string" && failedUrl.trim().length > 0
      ? failedUrl.trim()
      : null) ||
    session.currentLoadedUrl ||
    "about:blank";

  session.loadingRequestedUrl = null;
  session.currentRequestedUrl = nextRequestedUrl;
  session.failedRequestedUrl = nextRequestedUrl;

  if (
    typeof session.currentLoadedUrl !== "string" ||
    session.currentLoadedUrl.trim().length === 0
  ) {
    session.currentLoadedUrl = "about:blank";
  }
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

function getDefaultTerminalShellCommand() {
  return buildTerminalShellCandidates(undefined)[0]?.command ?? "";
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

function createBrowserSession(tabId, projectId) {
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
    sendToRenderer("browser:status", {
      loading: true,
      projectId,
      tabId,
    });
  });

  view.webContents.on("did-finish-load", () => {
    const session = browserSessions.get(tabId);
    if (session) {
      session.loadingRequestedUrl = null;
      session.currentLoadedUrl =
        session.view.webContents.getURL() || "about:blank";
      session.currentRequestedUrl = session.currentLoadedUrl;
      session.failedRequestedUrl = null;
      session.title = session.view.webContents.getTitle() || session.title;
    }

    sendBrowserPageState(browserSessions.get(tabId));
  });

  view.webContents.on("did-stop-loading", () => {
    const session = browserSessions.get(tabId);
    if (session && session.view.webContents.getURL() !== "about:blank") {
      session.loadingRequestedUrl = null;
      session.currentLoadedUrl = session.view.webContents.getURL();
      session.currentRequestedUrl = session.currentLoadedUrl;
      session.failedRequestedUrl = null;
      session.title = session.view.webContents.getTitle() || session.title;
    }

    sendToRenderer("browser:status", {
      loading: false,
      projectId,
      tabId,
    });
    sendBrowserPageState(browserSessions.get(tabId));
  });

  view.webContents.on("did-navigate", (_event, url) => {
    const session = browserSessions.get(tabId);
    if (!session) {
      return;
    }

    session.currentLoadedUrl = url || session.currentLoadedUrl;
    session.currentRequestedUrl = session.currentLoadedUrl;
    session.failedRequestedUrl = null;
    session.title = session.view.webContents.getTitle() || session.title;
    sendBrowserPageState(session);
  });

  view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }

    const session = browserSessions.get(tabId);
    if (!session) {
      return;
    }

    session.currentLoadedUrl = url || session.currentLoadedUrl;
    session.currentRequestedUrl = session.currentLoadedUrl;
    session.failedRequestedUrl = null;
    session.title = session.view.webContents.getTitle() || session.title;
    sendBrowserPageState(session);
  });

  view.webContents.on("page-title-updated", (_event, title) => {
    const session = browserSessions.get(tabId);
    if (!session) {
      return;
    }

    session.title = title || session.title;
    sendBrowserPageState(session);
  });

  view.webContents.on(
    "did-fail-load",
    (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      if (code === -3) {
        return;
      }

      const session = browserSessions.get(tabId);
      settleBrowserLoadFailure(session, validatedUrl);
      sendBrowserPageState(session);

      if (browserState.tabId !== tabId) {
        return;
      }

      sendToRenderer("browser:error", {
        code,
        description,
      });
    },
  );

  return {
    attached: false,
    currentLoadedUrl: "about:blank",
    currentRequestedUrl: "about:blank",
    failedRequestedUrl: null,
    lastBounds: null,
    loadRequestId: 0,
    loadingRequestedUrl: null,
    projectId,
    tabId,
    title: "New Tab",
    view,
  };
}

function getBrowserSession(tabId, projectId) {
  const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
  const normalizedProjectId =
    typeof projectId === "string" ? projectId.trim() : "";
  if (!normalizedTabId) {
    return null;
  }

  const existing = browserSessions.get(normalizedTabId);
  if (existing) {
    if (normalizedProjectId) {
      existing.projectId = normalizedProjectId;
    }
    return existing;
  }

  const created = createBrowserSession(normalizedTabId, normalizedProjectId);
  browserSessions.set(normalizedTabId, created);
  return created;
}

function attachBrowserSession(session) {
  if (!mainWindow || mainWindow.isDestroyed() || !session) {
    return;
  }

  mainWindow.contentView.addChildView(session.view);
  if (!session.attached) {
    session.attached = true;
  }
}

function detachBrowserSession(session) {
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

function detachAllBrowserSessions() {
  for (const session of browserSessions.values()) {
    detachBrowserSession(session);
  }
}

function stopBrowserNavigation(tabId, projectId) {
  const session = getBrowserSession(tabId, projectId);
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

  sendToRenderer("browser:status", {
    loading: false,
    projectId: session.projectId,
    tabId: session.tabId,
  });
}

function navigateBrowserHistory(tabId, projectId, direction) {
  const session = getBrowserSession(tabId, projectId);
  if (!session) {
    return;
  }

  try {
    const navigationHistory = session.view.webContents.navigationHistory;

    if (direction === "back" && navigationHistory?.canGoBack()) {
      session.view.webContents.goBack();
    } else if (direction === "forward" && navigationHistory?.canGoForward()) {
      session.view.webContents.goForward();
    }
  } catch {
    // ignore history navigation failures
  }

  sendBrowserPageState(session);
}

function applyBrowserState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const { bounds, projectId, tabId, url, visible } = browserState;
  const canRender =
    visible &&
    typeof projectId === "string" &&
    projectId.trim().length > 0 &&
    typeof tabId === "string" &&
    tabId.trim().length > 0 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    isHttpUrl(url);

  if (!canRender) {
    detachAllBrowserSessions();
    if (typeof tabId === "string" && tabId.trim().length > 0) {
      sendToRenderer("browser:status", {
        loading: false,
        projectId,
        tabId,
      });
    }
    activeBrowserTabId = null;
    return;
  }

  const nextSession = getBrowserSession(tabId, projectId);
  if (!nextSession) {
    return;
  }

  const roundedBounds = {
    height: Math.round(bounds.height),
    width: Math.round(bounds.width),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  };
  const currentProjectSessions = [];

  for (const session of browserSessions.values()) {
    if (session.projectId === projectId) {
      currentProjectSessions.push(session);
      continue;
    }

    detachBrowserSession(session);
  }

  for (const session of currentProjectSessions) {
    if (session.tabId === nextSession.tabId) {
      continue;
    }

    attachBrowserSession(session);
    session.view.setBounds(roundedBounds);
    session.lastBounds = roundedBounds;
  }

  attachBrowserSession(nextSession);
  nextSession.view.setBounds(roundedBounds);
  nextSession.lastBounds = roundedBounds;
  activeBrowserTabId = nextSession.tabId;

  const forceReload = browserState.reload;
  browserState.reload = false;

  if (
    (!forceReload && nextSession.failedRequestedUrl === url) ||
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
      sendToRenderer("browser:error", {
        code: "RELOAD_FAILED",
        description: error instanceof Error ? error.message : "Unknown error",
      });
      sendToRenderer("browser:status", {
        loading: false,
        projectId: nextSession.projectId,
        tabId: nextSession.tabId,
      });
    }

    return;
  }

  nextSession.currentRequestedUrl = url;
  nextSession.loadingRequestedUrl = url;
  nextSession.failedRequestedUrl = null;
  const requestId = ++nextSession.loadRequestId;
  const candidates = getBrowserLoadCandidates(url);

  const loadCandidate = async (index = 0) => {
    if (requestId !== nextSession.loadRequestId) {
      return;
    }

    const candidate = candidates[index];
    if (!candidate) {
      if (requestId !== nextSession.loadRequestId) {
        return;
      }

      settleBrowserLoadFailure(nextSession, url);
      sendBrowserPageState(nextSession);

      if (browserState.tabId === nextSession.tabId) {
        sendToRenderer("browser:error", {
          code: "LOAD_URL_FAILED",
          description: "Failed to load browser URL.",
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
      nextSession.currentRequestedUrl = candidate;
      nextSession.currentLoadedUrl = candidate;
      nextSession.title =
        nextSession.view.webContents.getTitle() || nextSession.title;
      sendBrowserPageState(nextSession);
    } catch (error) {
      if (requestId !== nextSession.loadRequestId) {
        return;
      }

      if (index + 1 < candidates.length) {
        await loadCandidate(index + 1);
        return;
      }

      settleBrowserLoadFailure(nextSession, url);
      sendBrowserPageState(nextSession);

      if (browserState.tabId === nextSession.tabId) {
        sendToRenderer("browser:error", {
          code: "LOAD_URL_FAILED",
          description: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  };

  void loadCandidate();
}

function destroyBrowserTab(tabId) {
  const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
  if (!normalizedTabId) return;

  const session = browserSessions.get(normalizedTabId);
  if (!session) return;

  detachBrowserSession(session);

  try {
    session.view.webContents.close();
  } catch {
    // ignore close failures
  }

  browserSessions.delete(normalizedTabId);

  if (activeBrowserTabId === normalizedTabId) {
    activeBrowserTabId = null;
  }

  if (browserState.tabId === normalizedTabId) {
    browserState.tabId = null;
    browserState.url = "about:blank";
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
    applyBrowserState();
  });

  mainWindow.on("closed", () => {
    detachAllBrowserSessions();
    activeBrowserTabId = null;
    browserState.projectId = null;
    browserState.tabId = null;
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

ipcMain.handle("terminal:get-default-shell", () => {
  return getDefaultTerminalShellCommand();
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

// ── Open-in-editor detection ─────────────────────────────────────────

const KNOWN_EDITORS = [
  // IDEs & editors
  {
    id: "vscode",
    name: "VS Code",
    win: [
      ...(process.env.LOCALAPPDATA
        ? [
            path.join(
              process.env.LOCALAPPDATA,
              "Programs",
              "Microsoft VS Code",
              "Code.exe",
            ),
            path.join(
              process.env.LOCALAPPDATA,
              "Programs",
              "Microsoft VS Code",
              "bin",
              "code.cmd",
            ),
          ]
        : []),
      ...(process.env.ProgramFiles
        ? [path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")]
        : []),
      ...(process.env["ProgramFiles(x86)"]
        ? [
            path.join(
              process.env["ProgramFiles(x86)"],
              "Microsoft VS Code",
              "Code.exe",
            ),
          ]
        : []),
      "code.exe",
      "code.cmd",
    ],
    mac: [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ],
    linux: ["code"],
    args: (p) => [p],
  },
  {
    id: "cursor",
    name: "Cursor",
    win: ["cursor.cmd", "cursor.exe"],
    mac: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
    linux: ["cursor"],
    args: (p) => [p],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    win: ["windsurf.cmd", "windsurf.exe"],
    mac: ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],
    linux: ["windsurf"],
    args: (p) => [p],
  },
  {
    id: "zed",
    name: "Zed",
    win: ["zed.exe"],
    mac: ["/Applications/Zed.app/Contents/MacOS/cli"],
    linux: ["zed"],
    args: (p) => [p],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    win: ["webstorm64.exe", "webstorm.cmd"],
    mac: ["/Applications/WebStorm.app/Contents/MacOS/webstorm"],
    linux: ["webstorm"],
    args: (p) => [p],
  },
  {
    id: "phpstorm",
    name: "PhpStorm",
    win: ["phpstorm64.exe", "phpstorm.cmd"],
    mac: ["/Applications/PhpStorm.app/Contents/MacOS/phpstorm"],
    linux: ["phpstorm"],
    args: (p) => [p],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    win: ["pycharm64.exe", "pycharm.cmd"],
    mac: ["/Applications/PyCharm.app/Contents/MacOS/pycharm"],
    linux: ["pycharm"],
    args: (p) => [p],
  },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    win: ["idea64.exe", "idea.cmd"],
    mac: ["/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"],
    linux: ["idea"],
    args: (p) => [p],
  },
  {
    id: "sublime",
    name: "Sublime Text",
    win: [
      "C:\\Program Files\\Sublime Text\\subl.exe",
      "C:\\Program Files\\Sublime Text 3\\subl.exe",
    ],
    mac: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"],
    linux: ["subl"],
    args: (p) => [p],
  },
  {
    id: "vim",
    name: "Vim",
    win: [],
    mac: ["vim"],
    linux: ["vim"],
    args: (p) => [p],
  },
  {
    id: "neovim",
    name: "Neovim",
    win: ["nvim.exe"],
    mac: ["nvim"],
    linux: ["nvim"],
    args: (p) => [p],
  },
  // File explorers (shown as default "open folder" option)
  {
    id: "file-explorer",
    name:
      process.platform === "win32"
        ? "File Explorer"
        : process.platform === "darwin"
          ? "Finder"
          : "Files",
    win: ["explorer.exe"],
    mac: ["open"],
    linux: ["xdg-open"],
    args: (p) => [p],
    isFileExplorer: true,
  },
  // Terminal
  {
    id: "terminal",
    name: "Terminal",
    win: [
      ...(process.env.ProgramFiles
        ? [path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")]
        : []),
      "pwsh.exe",
      ...(WINDOWS_POWERSHELL_PATH ? [WINDOWS_POWERSHELL_PATH] : []),
      "powershell.exe",
      "wt.exe",
      ...(WINDOWS_CMD_PATH ? [WINDOWS_CMD_PATH] : []),
      "cmd.exe",
    ],
    mac: ["open", "/Applications/iTerm.app"],
    linux: ["x-terminal-emulator", "gnome-terminal", "konsole"],
    args: (p, executable) => {
      if (process.platform === "darwin") {
        return ["-a", "Terminal", p];
      }

      if (process.platform === "win32") {
        const executableName = executable
          ? path.basename(executable).toLowerCase()
          : "";

        if (executableName === "wt.exe") {
          return ["-d", p];
        }

        if (executableName === "cmd.exe") {
          return ["/K"];
        }

        return ["-NoExit"];
      }

      return [p];
    },
    isTerminal: true,
  },
];

function resolveExecutable(name) {
  // Absolute path — check directly
  if (path.isAbsolute(name)) {
    return existsSync(name) ? name : null;
  }

  // Search PATH
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(sep);

  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      if (existsSync(full) && statSync(full).isFile()) {
        return full;
      }
    } catch {
      // skip
    }
  }

  return null;
}

let cachedEditors = null;
let cachedEditorsTimestamp = 0;
const EDITOR_CACHE_TTL_MS = 30_000;

function detectAvailableEditors() {
  const now = Date.now();
  if (cachedEditors && now - cachedEditorsTimestamp < EDITOR_CACHE_TTL_MS) {
    return cachedEditors;
  }

  const platformKey =
    process.platform === "win32"
      ? "win"
      : process.platform === "darwin"
        ? "mac"
        : "linux";

  const results = [];

  for (const editor of KNOWN_EDITORS) {
    const candidates = editor[platformKey] || [];
    if (editor.isFileExplorer) {
      const resolved = candidates.map(resolveExecutable).find(Boolean) ?? null;
      results.push({
        id: editor.id,
        name: editor.name,
        executable: resolved,
        isFileExplorer: true,
        isTerminal: false,
      });
      continue;
    }

    for (const candidate of candidates) {
      const resolved = resolveExecutable(candidate);
      if (resolved) {
        results.push({
          id: editor.id,
          name: editor.name,
          executable: resolved,
          isFileExplorer: editor.isFileExplorer || false,
          isTerminal: editor.isTerminal || false,
        });
        break;
      }
    }
  }

  cachedEditors = results;
  cachedEditorsTimestamp = now;
  return results;
}

function resolveKnownEditor(editorId) {
  const editorDef = KNOWN_EDITORS.find((editor) => editor.id === editorId);
  if (!editorDef) {
    return null;
  }

  const platformKey =
    process.platform === "win32"
      ? "win"
      : process.platform === "darwin"
        ? "mac"
        : "linux";
  const candidates = editorDef[platformKey] || [];

  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (!resolved) {
      continue;
    }

    return {
      executable: resolved,
      id: editorDef.id,
      isFileExplorer: editorDef.isFileExplorer || false,
      isTerminal: editorDef.isTerminal || false,
      name: editorDef.name,
    };
  }

  return null;
}

ipcMain.handle("editors:detect", () => {
  return detectAvailableEditors();
});

ipcMain.handle("editors:open", (_event, { projectPath, editorId }) => {
  if (!projectPath || typeof projectPath !== "string") {
    return false;
  }

  const editor = resolveKnownEditor(editorId);
  if (!editor) {
    if (editorId === "terminal") {
      return false;
    }

    // Fallback: open folder in system file explorer
    shell.openPath(projectPath);
    return true;
  }

  const editorDef = KNOWN_EDITORS.find((e) => e.id === editorId);
  const args = editorDef
    ? editorDef.args(projectPath, editor.executable)
    : [projectPath];

  if (process.platform === "win32" && editor.isTerminal) {
    const launcher = WINDOWS_CMD_PATH ?? "cmd.exe";
    spawnProcess(
      launcher,
      [
        "/d",
        "/s",
        "/c",
        "start",
        "",
        "/D",
        projectPath,
        editor.executable,
        ...args,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    ).unref();

    return true;
  }

  const requiresShell =
    process.platform === "win32" &&
    [".bat", ".cmd"].includes(path.extname(editor.executable).toLowerCase());

  spawnProcess(editor.executable, args, {
    detached: true,
    shell: requiresShell,
    stdio: "ignore",
  }).unref();

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

ipcMain.on("browser:update", (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (
    typeof payload.projectId === "string" &&
    payload.projectId.trim().length > 0
  ) {
    browserState.projectId = payload.projectId.trim();
  }

  if (typeof payload.tabId === "string" && payload.tabId.trim().length > 0) {
    browserState.tabId = payload.tabId.trim();
  }

  if (typeof payload.destroyTab === "string") {
    destroyBrowserTab(payload.destroyTab);
    return;
  }

  if (payload.goBack === true) {
    navigateBrowserHistory(browserState.tabId, browserState.projectId, "back");
    return;
  }

  if (payload.goForward === true) {
    navigateBrowserHistory(
      browserState.tabId,
      browserState.projectId,
      "forward",
    );
    return;
  }

  if (payload.stop === true) {
    stopBrowserNavigation(browserState.tabId, browserState.projectId);
    return;
  }

  const nextBounds = payload.bounds;
  if (nextBounds && typeof nextBounds === "object") {
    browserState.bounds = {
      height: Number(nextBounds.height ?? browserState.bounds.height),
      width: Number(nextBounds.width ?? browserState.bounds.width),
      x: Number(nextBounds.x ?? browserState.bounds.x),
      y: Number(nextBounds.y ?? browserState.bounds.y),
    };
  }

  if (typeof payload.visible === "boolean") {
    browserState.visible = payload.visible;
  }

  if (payload.reload === true) {
    browserState.reload = true;
  }

  if (typeof payload.url === "string" && payload.url.trim().length > 0) {
    browserState.url = payload.url.trim();
  }

  applyBrowserState();
});

app.whenReady().then(async () => {
  if (process.platform === "darwin" && existsSync(appIconPath)) {
    app.dock?.setIcon(appIconPath);
  }

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
