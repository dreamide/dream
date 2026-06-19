import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

const DEFAULT_PERSISTED_STATE = {
  activeProjectId: null,
  activeBrowserTabIdByProject: {},
  browserTabsByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  projects: [],
  settings: {
    anthropicSelectedModels: [],
    autoAcceptPermissions: false,
    cursorSelectedModels: [],
    defaultGitGenerationModel: "",
    defaultModel: "",
    defaultModelSpeed: "standard",
    defaultReasoningEffort: null,
    expandToolCalls: false,
    groupToolCalls: false,
    openAiSelectedModels: [],
    openCodeSelectedModels: [],
    showReasoningSummaries: true,
    shellPath: "",
  },
  chatSort: "recent",
};
const RELATIONAL_SCHEMA_VERSION = 2;
const STATE_DB_FILENAME = "dream.db";
const STATE_DB_PATH_ENV_VAR = "DREAM_DB_PATH";
const DRIZZLE_MIGRATIONS_FOLDER = path.join(__dirname, "drizzle");
const DEFAULT_SPARKLES_PALETTE = "dream";
const SPARKLES_PALETTE_NAMES = new Set([
  "dream",
  "accent",
  "violet",
  "gold",
  "magenta",
  "emerald",
  "ember",
  "rainbow",
  "mono",
]);
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

export function resolveStateDatabasePath() {
  const configuredPath = process.env[STATE_DB_PATH_ENV_VAR]?.trim();
  if (configuredPath) {
    if (path.isAbsolute(configuredPath)) {
      return path.resolve(configuredPath);
    }

    return path.resolve(appRoot, configuredPath);
  }

  // Lazy-loaded so this module also works inside worker threads, where the
  // "electron" module is unavailable. Workers must set DREAM_DB_PATH (the
  // save worker always does), so this branch never runs there.
  const require = createRequire(import.meta.url);
  const { app } = require("electron");
  return path.join(app.getPath("userData"), STATE_DB_FILENAME);
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

function getNestedWorktree(parent, key) {
  const value = getNestedRecord(parent, key);
  const repoRoot = getNestedString(value, "repoRoot", "");
  const mainWorktreePath = getNestedString(value, "mainWorktreePath", "");
  const branch = getNestedString(value, "branch", "");

  if (value.kind !== "worktree" || !repoRoot || !mainWorktreePath || !branch) {
    return null;
  }

  return {
    baseRef: getNestedNullableString(value, "baseRef"),
    branch,
    createdAt:
      getNestedString(value, "createdAt", "") || new Date().toISOString(),
    kind: "worktree",
    mainWorktreePath,
    managed: getNestedBoolean(value, "managed", false),
    parentProjectId: getNestedNullableString(value, "parentProjectId"),
    repoRoot,
  };
}

function getNestedTimestamp(parent, key) {
  const value = getNestedString(parent, key, "");
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function getNestedStringArray(parent, key) {
  const value = parent?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const strings = [];
  for (const item of value) {
    const stringValue = typeof item === "string" ? item.trim() : "";
    if (!stringValue || seen.has(stringValue)) {
      continue;
    }

    seen.add(stringValue);
    strings.push(stringValue);
  }

  return strings;
}

function getNestedNumberRecord(parent, key) {
  const value = parent?.[key];
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([recordKey, recordValue]) =>
        typeof recordKey === "string" &&
        recordKey.trim() &&
        typeof recordValue === "number" &&
        Number.isFinite(recordValue) &&
        recordValue > 0,
    ),
  );
}

function getNestedRightPanelView(parent, key, fallback = "changes") {
  const value = parent?.[key];
  return value === "browser" ||
    value === "explorer" ||
    value === "changes" ||
    value === "terminal"
    ? value
    : fallback;
}

function normalizeSparklesPaletteName(value) {
  if (value === "arctic") {
    return "violet";
  }

  return typeof value === "string" && SPARKLES_PALETTE_NAMES.has(value)
    ? value
    : DEFAULT_SPARKLES_PALETTE;
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

function tableExists(database, tableName) {
  const row = database
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
      `,
    )
    .get(tableName);

  return typeof row?.name === "string";
}

function loadLegacyAppState(database) {
  if (!tableExists(database, "app_state")) {
    return null;
  }

  const row = database
    .prepare("SELECT value FROM app_state WHERE key = ? LIMIT 1")
    .get("ide-state");
  const state = parseJson(row?.value, null);
  return isRecord(state) ? state : null;
}

function hasRelationalState(database) {
  if (!tableExists(database, "projects") || !tableExists(database, "config")) {
    return false;
  }

  const projectCount = database
    .prepare("SELECT COUNT(*) AS count FROM projects")
    .get().count;
  const configCount = database
    .prepare("SELECT COUNT(*) AS count FROM config")
    .get().count;

  return projectCount > 0 || configCount > 0;
}

function getTableRowCount(database, tableName) {
  if (!tableExists(database, tableName)) {
    return 0;
  }

  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
    .count;
}

function stateHasChats(state) {
  if (!isRecord(state)) {
    return false;
  }

  return (
    Array.isArray(state.chats) &&
    state.chats.some((chat) => isRecord(chat) && typeof chat.id === "string")
  );
}

function shouldImportLegacyState(database, legacyState, hadRelationalState) {
  if (!stateHasChats(legacyState)) {
    return false;
  }

  if (!hadRelationalState) {
    return true;
  }

  return getTableRowCount(database, "chats") === 0;
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

function buildProjectMetadata(project) {
  const metadata = getMetadataObject(project.metadata);
  const worktree = getNestedWorktree(project, "worktree");
  const projectIcon = isRecord(project.icon)
    ? project.icon
    : getNestedRecord(metadata, "icon");
  const iconPath =
    typeof projectIcon.path === "string" ? projectIcon.path.trim() : "";
  const icon = iconPath
    ? {
        path: iconPath,
        mimeType:
          typeof projectIcon.mimeType === "string" &&
          projectIcon.mimeType.trim()
            ? projectIcon.mimeType.trim()
            : "application/octet-stream",
        source:
          typeof projectIcon.source === "string" && projectIcon.source.trim()
            ? projectIcon.source.trim()
            : "unknown",
        mtimeMs:
          typeof projectIcon.mtimeMs === "number" ? projectIcon.mtimeMs : 0,
      }
    : null;
  const modelSelection = {
    ...getNestedRecord(metadata, "modelSelection"),
    model: typeof project.model === "string" ? project.model : "",
    modelSpeed:
      typeof project.modelSpeed === "string" ? project.modelSpeed : "standard",
    provider:
      typeof project.provider === "string" ? project.provider : "openai",
    reasoningEffort:
      typeof project.reasoningEffort === "string"
        ? project.reasoningEffort
        : null,
  };
  const browser = {
    ...getNestedRecord(metadata, "browser"),
    url: typeof project.browserUrl === "string" ? project.browserUrl : "",
  };
  const lastUsedAt =
    typeof project.lastUsedAt === "string" &&
    Number.isFinite(Date.parse(project.lastUsedAt))
      ? project.lastUsedAt
      : getNestedTimestamp(metadata, "lastUsedAt");
  const ui = {
    ...getNestedRecord(metadata, "ui"),
    activeChatId:
      typeof project.ui?.activeChatId === "string"
        ? project.ui.activeChatId
        : null,
    openChatIds: getNestedStringArray(project.ui, "openChatIds"),
    chatColumnWidths: getNestedNumberRecord(project.ui, "chatColumnWidths"),
    multiChat: getNestedBoolean(
      project.ui,
      "multiChat",
      getNestedBoolean(getNestedRecord(metadata, "ui"), "multiChat", false),
    ),
  };
  const existingPanelVisibility = getNestedRecord(ui, "panelVisibility");
  const existingPanelSizes = getNestedRecord(ui, "panelSizes");
  const projectUi = isRecord(project.ui) ? project.ui : {};
  const projectPanelSizes = isRecord(projectUi.panelSizes)
    ? projectUi.panelSizes
    : existingPanelSizes;
  const rightPanelOpen = getNestedBoolean(
    projectUi,
    "rightPanelOpen",
    getNestedBoolean(existingPanelVisibility, "right", true),
  );
  const persistedPanelVisibility = { ...existingPanelVisibility };
  delete persistedPanelVisibility.left;

  ui.panelVisibility = {
    ...persistedPanelVisibility,
    middle: true,
    right: rightPanelOpen,
  };
  ui.rightPanelView = getNestedRightPanelView(
    projectUi,
    "rightPanelView",
    getNestedRightPanelView(ui, "rightPanelView", "changes"),
  );
  ui.chatHistoryPanelOpen = getNestedBoolean(
    projectUi,
    "chatHistoryPanelOpen",
    getNestedBoolean(ui, "chatHistoryPanelOpen", false),
  );
  ui.panelSizes = {
    chatHistoryPanelWidth: getNestedNumber(
      projectPanelSizes,
      "chatHistoryPanelWidth",
      getNestedNumber(existingPanelSizes, "chatHistoryPanelWidth", 400),
    ),
    leftSidebarWidth: getNestedNumber(
      projectPanelSizes,
      "leftSidebarWidth",
      getNestedNumber(existingPanelSizes, "leftSidebarWidth", 240),
    ),
    rightPanelWidth: getNestedNumber(
      projectPanelSizes,
      "rightPanelWidth",
      getNestedNumber(existingPanelSizes, "rightPanelWidth", 520),
    ),
    terminalHeight: getNestedNumber(
      projectPanelSizes,
      "terminalHeight",
      getNestedNumber(existingPanelSizes, "terminalHeight", 260),
    ),
  };

  return {
    ...metadata,
    browser,
    icon,
    lastUsedAt,
    modelSelection,
    runCommand:
      typeof project.runCommand === "string" ? project.runCommand : "pnpm dev",
    ui,
    worktree,
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
    modelSpeed:
      typeof chat.remoteConversationModelSpeed === "string" &&
      chat.remoteConversationModelSpeed.trim()
        ? chat.remoteConversationModelSpeed
        : null,
    projectPath:
      typeof chat.remoteConversationProjectPath === "string" &&
      chat.remoteConversationProjectPath.trim()
        ? chat.remoteConversationProjectPath
        : null,
  };
  const modelSelection = {
    ...getNestedRecord(metadata, "modelSelection"),
    agentMode: chat.agentMode === "plan" ? "plan" : "build",
    model: typeof chat.model === "string" ? chat.model : "",
    modelSpeed:
      typeof chat.modelSpeed === "string" ? chat.modelSpeed : "standard",
    provider: typeof chat.provider === "string" ? chat.provider : "openai",
    reasoningEffort:
      typeof chat.reasoningEffort === "string" ? chat.reasoningEffort : null,
  };

  return {
    ...metadata,
    modelSelection,
    remoteConversation,
    sparklesPalette: normalizeSparklesPaletteName(
      chat.sparklesPalette ?? metadata.sparklesPalette,
    ),
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
      "browserTabsByProject",
      isRecord(state.browserTabsByProject) ? state.browserTabsByProject : {},
      now,
    );
    writeConfig(
      database,
      "activeBrowserTabIdByProject",
      isRecord(state.activeBrowserTabIdByProject)
        ? state.activeBrowserTabIdByProject
        : {},
      now,
    );
    writeConfig(
      database,
      "settings.defaultModel",
      settings.defaultModel ?? "",
      now,
    );
    writeConfig(
      database,
      "settings.defaultGitGenerationModel",
      settings.defaultGitGenerationModel ?? "",
      now,
    );
    writeConfig(
      database,
      "settings.defaultModelSpeed",
      settings.defaultModelSpeed ?? "standard",
      now,
    );
    writeConfig(
      database,
      "settings.defaultReasoningEffort",
      settings.defaultReasoningEffort ?? null,
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
    writeConfig(
      database,
      "settings.openCodeSelectedModels",
      Array.isArray(settings.openCodeSelectedModels)
        ? settings.openCodeSelectedModels
        : [],
      now,
    );
    writeConfig(
      database,
      "settings.cursorSelectedModels",
      Array.isArray(settings.cursorSelectedModels)
        ? settings.cursorSelectedModels
        : [],
      now,
    );
    writeConfig(
      database,
      "settings.autoAcceptPermissions",
      settings.autoAcceptPermissions === true,
      now,
    );
    writeConfig(database, "settings.shellPath", settings.shellPath ?? "", now);
    writeConfig(
      database,
      "settings.expandToolCalls",
      settings.expandToolCalls === true,
      now,
    );
    writeConfig(
      database,
      "settings.groupToolCalls",
      settings.groupToolCalls === true,
      now,
    );
    writeConfig(
      database,
      "settings.showReasoningSummaries",
      settings.showReasoningSummaries ?? true,
      now,
    );

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
      const metadata = buildProjectMetadata(project);

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
  for (const row of projectRows) {
    const metadata = getMetadataObject(row.metadata);
    const icon = getNestedRecord(metadata, "icon");
    const iconPath = getNestedString(icon, "path", "");
    const modelSelection = getNestedRecord(metadata, "modelSelection");
    const browser = getNestedRecord(metadata, "browser");
    const ui = getNestedRecord(metadata, "ui");
    const worktree = getNestedWorktree(metadata, "worktree");
    const lastUsedAt = getNestedTimestamp(metadata, "lastUsedAt");
    const project = {
      browserUrl: getNestedString(browser, "url", ""),
      id: row.id,
      icon: iconPath
        ? {
            path: iconPath,
            mimeType: getNestedString(
              icon,
              "mimeType",
              "application/octet-stream",
            ),
            source: getNestedString(icon, "source", "unknown"),
            mtimeMs: getNestedNumber(icon, "mtimeMs", 0),
          }
        : null,
      lastUsedAt,
      metadata,
      model: getNestedString(modelSelection, "model", ""),
      modelSpeed: getNestedString(modelSelection, "modelSpeed", "standard"),
      name: row.name || getProjectName(row.path),
      path: row.path || "",
      provider: getNestedString(modelSelection, "provider", "openai"),
      reasoningEffort: getNestedString(modelSelection, "reasoningEffort", null),
      runCommand: getNestedString(metadata, "runCommand", "pnpm dev"),
      worktree,
    };

    project.ui = {
      activeChatId: getNestedNullableString(ui, "activeChatId"),
      openChatIds: getNestedStringArray(ui, "openChatIds"),
      chatColumnWidths: getNestedNumberRecord(ui, "chatColumnWidths"),
      chatHistoryPanelOpen: getNestedBoolean(ui, "chatHistoryPanelOpen", false),
      multiChat: getNestedBoolean(ui, "multiChat", false),
      panelSizes: {
        chatHistoryPanelWidth: getNestedNumber(
          getNestedRecord(ui, "panelSizes"),
          "chatHistoryPanelWidth",
          400,
        ),
        leftSidebarWidth: getNestedNumber(
          getNestedRecord(ui, "panelSizes"),
          "leftSidebarWidth",
          240,
        ),
        rightPanelWidth: getNestedNumber(
          getNestedRecord(ui, "panelSizes"),
          "rightPanelWidth",
          520,
        ),
        terminalHeight: getNestedNumber(
          getNestedRecord(ui, "panelSizes"),
          "terminalHeight",
          260,
        ),
      },
      rightPanelOpen: getNestedBoolean(
        getNestedRecord(ui, "panelVisibility"),
        "right",
        true,
      ),
      rightPanelView: getNestedRightPanelView(ui, "rightPanelView", "changes"),
    };
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
      agentMode: getNestedString(modelSelection, "agentMode", "build"),
      model: getNestedString(modelSelection, "model", ""),
      modelSpeed: getNestedString(modelSelection, "modelSpeed", "standard"),
      projectId: row.project_id,
      provider: getNestedString(modelSelection, "provider", "openai"),
      reasoningEffort: getNestedString(modelSelection, "reasoningEffort", null),
      remoteConversationId: getNestedNullableString(remoteConversation, "id"),
      remoteConversationModel: getNestedNullableString(
        remoteConversation,
        "model",
      ),
      remoteConversationModelSpeed: getNestedNullableString(
        remoteConversation,
        "modelSpeed",
      ),
      remoteConversationProjectPath: getNestedNullableString(
        remoteConversation,
        "projectPath",
      ),
      sparklesPalette: normalizeSparklesPaletteName(metadata.sparklesPalette),
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
    const requestedChatId = project.ui.activeChatId;
    const projectChats = chats.filter(
      (chat) => chat.projectId === project.id && chat.deletedAt === null,
    );
    const availableChatIds = new Set(projectChats.map((chat) => chat.id));
    const activeChatId = availableChatIds.has(requestedChatId)
      ? requestedChatId
      : (projectChats[0]?.id ?? null);
    const openChatIds = project.ui.multiChat
      ? project.ui.openChatIds.filter((chatId) => availableChatIds.has(chatId))
      : [];
    if (activeChatId) {
      if (project.ui.multiChat) {
        if (!openChatIds.includes(activeChatId)) {
          openChatIds.push(activeChatId);
        }
      } else {
        openChatIds.splice(0, openChatIds.length, activeChatId);
      }
    }
    const openChatIdSet = new Set(openChatIds);

    project.ui = {
      ...project.ui,
      activeChatId,
      openChatIds,
      chatColumnWidths: Object.fromEntries(
        Object.entries(project.ui.chatColumnWidths).filter(([chatId]) =>
          openChatIdSet.has(chatId),
        ),
      ),
    };
  }

  const activeProjectId =
    typeof config.activeProjectId === "string" ? config.activeProjectId : null;
  return {
    activeProjectId,
    activeBrowserTabIdByProject: isRecord(config.activeBrowserTabIdByProject)
      ? config.activeBrowserTabIdByProject
      : {},
    browserTabsByProject: isRecord(config.browserTabsByProject)
      ? config.browserTabsByProject
      : {},
    chats,
    chatSort: typeof config.chatSort === "string" ? config.chatSort : "recent",
    closedProjects,
    messagesByChatId,
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
      defaultGitGenerationModel:
        typeof config["settings.defaultGitGenerationModel"] === "string"
          ? config["settings.defaultGitGenerationModel"]
          : "",
      defaultModelSpeed:
        typeof config["settings.defaultModelSpeed"] === "string"
          ? config["settings.defaultModelSpeed"]
          : "standard",
      defaultReasoningEffort:
        typeof config["settings.defaultReasoningEffort"] === "string"
          ? config["settings.defaultReasoningEffort"]
          : null,
      autoAcceptPermissions:
        typeof config["settings.autoAcceptPermissions"] === "boolean"
          ? config["settings.autoAcceptPermissions"]
          : false,
      expandToolCalls:
        typeof config["settings.expandToolCalls"] === "boolean"
          ? config["settings.expandToolCalls"]
          : config["settings.expandShellToolParts"] === true ||
            config["settings.expandEditToolParts"] === true,
      groupToolCalls:
        typeof config["settings.groupToolCalls"] === "boolean"
          ? config["settings.groupToolCalls"]
          : false,
      openAiSelectedModels: Array.isArray(
        config["settings.openAiSelectedModels"],
      )
        ? config["settings.openAiSelectedModels"]
        : [],
      openCodeSelectedModels: Array.isArray(
        config["settings.openCodeSelectedModels"],
      )
        ? config["settings.openCodeSelectedModels"]
        : [],
      cursorSelectedModels: Array.isArray(
        config["settings.cursorSelectedModels"],
      )
        ? config["settings.cursorSelectedModels"]
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

function ensureTableColumn(database, tableName, columnName, columnDefinition) {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = rows.some((row) => row?.name === columnName);
  if (hasColumn) {
    return;
  }

  database.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
  );
}

function getMigrationDirective(statement) {
  const lines = statement
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const directiveLine = lines.find((line) =>
    line.startsWith("-- dream:ensure-column "),
  );

  if (!directiveLine) {
    return null;
  }

  const [, , tableName, columnName, ...definitionParts] =
    directiveLine.split(/\s+/);
  const columnDefinition = definitionParts.join(" ").trim();

  if (!tableName || !columnName || !columnDefinition) {
    throw new Error(`Invalid dream migration directive: ${directiveLine}`);
  }

  return {
    columnDefinition,
    columnName,
    tableName,
  };
}

function stripMigrationDirectives(statement) {
  return statement
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("-- dream:"))
    .join("\n")
    .trim();
}

function runDrizzleMigrations(database) {
  const migrations = readMigrationFiles({
    migrationsFolder: DRIZZLE_MIGRATIONS_FOLDER,
  });

  database.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);

  const lastMigration = database
    .prepare(
      `
        SELECT id, hash, created_at
        FROM __drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get();
  const lastMigrationTimestamp = Number(lastMigration?.created_at ?? 0);

  database.exec("BEGIN");

  try {
    for (const migration of migrations) {
      if (lastMigrationTimestamp >= migration.folderMillis) {
        continue;
      }

      for (const rawStatement of migration.sql) {
        const statement = rawStatement.trim();
        if (!statement) {
          continue;
        }

        const directive = getMigrationDirective(statement);
        if (directive) {
          ensureTableColumn(
            database,
            directive.tableName,
            directive.columnName,
            directive.columnDefinition,
          );
        }

        const sqlStatement = stripMigrationDirectives(statement);
        if (sqlStatement) {
          database.exec(sqlStatement);
        }
      }

      database
        .prepare(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run(migration.hash, migration.folderMillis);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getStateDatabase() {
  if (stateDatabase) {
    return stateDatabase;
  }

  const databasePath = resolveStateDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const legacyState = loadLegacyAppState(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
  `);
  const hadRelationalState = hasRelationalState(database);
  runDrizzleMigrations(database);

  if (shouldImportLegacyState(database, legacyState, hadRelationalState)) {
    saveStateToRelationalDatabase(database, legacyState);
  }

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

export function savePersistedState(state) {
  const database = getStateDatabase();
  return saveStateToRelationalDatabase(database, state);
}

export function loadPersistedState() {
  const database = getStateDatabase();
  return loadStateFromRelationalDatabase(database);
}

export function resolvePersistedProjectPath({ chatId, projectId } = {}) {
  const database = getStateDatabase();
  const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
  const normalizedProjectId =
    typeof projectId === "string" ? projectId.trim() : "";

  if (normalizedChatId) {
    const row = database
      .prepare(
        `
          SELECT projects.path AS path
          FROM chats
          INNER JOIN projects ON projects.id = chats.project_id
          WHERE chats.id = ?
          LIMIT 1
        `,
      )
      .get(normalizedChatId);

    if (typeof row?.path === "string" && row.path.trim()) {
      return row.path;
    }
  }

  if (normalizedProjectId) {
    const row = database
      .prepare(
        `
          SELECT path
          FROM projects
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(normalizedProjectId);

    if (typeof row?.path === "string" && row.path.trim()) {
      return row.path;
    }
  }

  return null;
}

export function closePersistedStateDatabase() {
  if (!stateDatabase) {
    return;
  }

  stateDatabase.close();
  stateDatabase = null;
}
