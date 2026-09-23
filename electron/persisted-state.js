import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { normalizeMcpServerList } from "./api/chat/mcp-servers.js";
import { normalizeChatPermissionMode } from "./shared/chat-permissions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

const DEFAULT_PERSISTED_STATE = {
  activeProjectId: null,
  appView: "code",
  tasksProjectId: null,
  taskConfig: null,
  tasksChatPanelWidth: 560,
  tasks: [],
  activeBrowserTabIdByProject: {},
  browserTabsByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  projects: [],
  settings: {
    anthropicSelectedModels: [],
    archiveChatsAfterDays: 30,
    cursorSelectedModels: [],
    grokSelectedModels: [],
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
const INSTALL_ID_CONFIG_KEY = "installId";
const THEME_PREFERENCES_CONFIG_KEY = "themePreferences";
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
let stateDatabasePath = null;

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

function isUuidV4(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function normalizeProjectPathKey(projectPath) {
  const trimmed = typeof projectPath === "string" ? projectPath.trim() : "";
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "") || trimmed;
  const normalized = withoutTrailingSeparators.replace(/\\/g, "/");
  const isWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || trimmed.includes("\\");

  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

function resolveConfiguredStateDatabasePath(configuredPath) {
  const normalizedPath =
    typeof configuredPath === "string" ? configuredPath.trim() : "";
  if (!normalizedPath) {
    return null;
  }

  if (path.isAbsolute(normalizedPath)) {
    return path.resolve(normalizedPath);
  }

  return path.resolve(appRoot, normalizedPath);
}

export function resolveStateDatabasePath() {
  const configuredPath = resolveConfiguredStateDatabasePath(
    process.env[STATE_DB_PATH_ENV_VAR],
  );
  if (configuredPath) {
    return configuredPath;
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

// The Tasks workspace was called "pipeline" (and "kanban" before that). Those
// names survive in saved data: as view values, and as the `pipelineTasks` /
// `pipelineConfig` / `pipelineProjectId` keys read as fallbacks below.
//
// The workspace view used to live per project in `metadata.ui.workspaceView`.
// It is now the app-level `appView` config key; the legacy value only seeds it
// on the first load.
function isLegacyTasksWorkspaceView(value) {
  return value === "pipeline" || value === "kanban";
}

function getAppView(value, fallback = "code") {
  if (value === "pipeline") {
    return "tasks";
  }
  return value === "code" || value === "tasks" ? value : fallback;
}

function getTasksProjectId(value) {
  return typeof value === "string" && value ? value : null;
}

function getTasksChatPanelWidth(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PERSISTED_STATE.tasksChatPanelWidth;
}

function getChatTaskId(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNestedRightPanelView(parent, key, fallback = "changes") {
  const value = parent?.[key];
  return value === "browser" ||
    value === "explorer" ||
    value === "changes" ||
    value === "terminal" ||
    value === "stash"
    ? value
    : fallback;
}

function getNestedStashItems(parent) {
  const value = isRecord(parent) ? parent.stashItems : null;
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set();
  const items = [];

  for (const rawItem of value) {
    if (!isRecord(rawItem) || typeof rawItem.id !== "string") {
      continue;
    }

    const id = rawItem.id.trim();
    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    items.push(rawItem);
  }

  return items;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Upgrades a card from the retired Kanban board into a task. Legacy
 * cards keep running in the parent project (no worktree).
 *
 * Keep in sync with `migrateKanbanCard` in
 * `src/components/ide/task-state.ts`.
 */
function migrateKanbanCard(card) {
  if (!isRecord(card)) {
    return null;
  }

  const createdAt = nonEmptyString(card.createdAt) ?? new Date().toISOString();
  const updatedAt = nonEmptyString(card.updatedAt) ?? createdAt;
  const chatId = nonEmptyString(card.chatId);
  const step =
    card.column === "inProgress"
      ? "build"
      : card.column === "review"
        ? "review"
        : card.column === "done"
          ? "merge"
          : "backlog";
  const finished = step === "review" || step === "merge";

  return {
    baseRef: null,
    branch: null,
    completion:
      step === "merge"
        ? { at: updatedAt, kind: "legacy", mergeCommit: null, prUrl: null }
        : null,
    createdAt,
    description: typeof card.description === "string" ? card.description : "",
    id: card.id,
    runs:
      chatId && step !== "backlog"
        ? [
            {
              chatId,
              feedback: null,
              finishedAt: finished ? updatedAt : null,
              id: `legacy-${String(card.id)}`,
              output: null,
              startedAt: createdAt,
              step: "build",
            },
          ]
        : [],
    step,
    title: typeof card.title === "string" ? card.title : "",
    updatedAt,
    worktreePath: null,
    worktreeProjectId: null,
  };
}

function getNestedTasks(parent) {
  const record = isRecord(parent) ? parent : null;
  const value = Array.isArray(record?.tasks)
    ? record.tasks
    : Array.isArray(record?.pipelineTasks)
      ? record.pipelineTasks
      : Array.isArray(record?.kanbanCards)
        ? record.kanbanCards.map(migrateKanbanCard)
        : null;
  if (!value) {
    return [];
  }

  const seenIds = new Set();
  const tasks = [];

  for (const rawTask of value) {
    if (!isRecord(rawTask) || typeof rawTask.id !== "string") {
      continue;
    }

    const id = rawTask.id.trim();
    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    tasks.push(rawTask);
  }

  return tasks;
}

const LEGACY_PROJECT_TASK_KEYS = ["tasks", "pipelineTasks", "kanbanCards"];

/**
 * Tasks used to be stored on their project, under `metadata.ui`. Returns the
 * ones `project` still carries, or `null` when it carries none at all (which
 * is different from carrying an empty list).
 */
function getLegacyProjectTasks(project) {
  const sources = [
    isRecord(project?.ui) ? project.ui : null,
    getNestedRecord(getMetadataObject(project?.metadata), "ui"),
  ];
  const source = sources.find(
    (candidate) =>
      candidate &&
      LEGACY_PROJECT_TASK_KEYS.some((key) => Object.hasOwn(candidate, key)),
  );
  return source ? getNestedTasks(source) : null;
}

/**
 * Appends tasks still stored on their projects to the app-wide list. A task
 * already in the list under the same project was migrated before; an id that
 * clashes with another project's task (ids used to be unique per project only)
 * gets a new one.
 */
function appendLegacyProjectTasks(tasks, projects) {
  const projectIdByTaskId = new Map(
    tasks.map((task) => [task.id, task.projectId]),
  );

  for (const project of projects) {
    for (const legacyTask of getLegacyProjectTasks(project) ?? []) {
      const existingProjectId = projectIdByTaskId.get(legacyTask.id);
      if (existingProjectId === project.id) {
        continue;
      }

      const id = existingProjectId === undefined ? legacyTask.id : randomUUID();
      projectIdByTaskId.set(id, project.id);
      tasks.push({ ...legacyTask, id, projectId: project.id });
    }
  }

  return tasks;
}

/**
 * The tasks a save should write, or `null` to leave the table alone: a state
 * from before tasks were app-wide whose projects carry no tasks either says
 * nothing about them, and must not wipe the table.
 */
function getTasksToPersist(state, projects) {
  if (Array.isArray(state.tasks)) {
    return state.tasks;
  }

  return projects.some((project) => getLegacyProjectTasks(project) !== null)
    ? appendLegacyProjectTasks([], projects)
    : null;
}

const TASK_COLUMN_KEYS = new Set([
  "createdAt",
  "id",
  "projectId",
  "step",
  "title",
  "updatedAt",
]);

function saveTasksToRelationalDatabase(database, tasks, knownProjectIds, now) {
  const existingCreatedAt = new Map(
    database
      .prepare("SELECT id, created_at FROM tasks")
      .all()
      .map((row) => [row.id, row.created_at]),
  );
  const insertTask = database.prepare(
    `
      INSERT INTO tasks (
        id,
        project_id,
        step,
        title,
        sort_order,
        payload,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        step = excluded.step,
        title = excluded.title,
        sort_order = excluded.sort_order,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `,
  );
  const persistedTaskIds = [];

  for (const task of tasks) {
    if (
      !isRecord(task) ||
      typeof task.id !== "string" ||
      !task.id.trim() ||
      persistedTaskIds.includes(task.id) ||
      // A task never outlives its project.
      !knownProjectIds.has(task.projectId)
    ) {
      continue;
    }

    const createdAt =
      nonEmptyString(task.createdAt) ?? existingCreatedAt.get(task.id) ?? now;
    insertTask.run(
      task.id,
      task.projectId,
      nonEmptyString(task.step) ?? "backlog",
      typeof task.title === "string" ? task.title : "",
      persistedTaskIds.length,
      toJson(
        Object.fromEntries(
          Object.entries(task).filter(([key]) => !TASK_COLUMN_KEYS.has(key)),
        ),
      ),
      createdAt,
      nonEmptyString(task.updatedAt) ?? createdAt,
    );
    persistedTaskIds.push(task.id);
  }

  if (persistedTaskIds.length === 0) {
    database.prepare("DELETE FROM tasks").run();
  } else {
    database
      .prepare(
        `DELETE FROM tasks WHERE id NOT IN (${persistedTaskIds
          .map(() => "?")
          .join(", ")})`,
      )
      .run(...persistedTaskIds);
  }
}

/**
 * Chats saved before chats knew their task are claimed by the task whose runs
 * point at them. Mutates `chats`; the next save writes the link.
 */
function backfillChatTaskIds(chats, tasks) {
  const taskIdByChatId = new Map();
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== "string") {
      continue;
    }
    const runs = Array.isArray(task.runs) ? task.runs : [];
    for (const run of runs) {
      if (isRecord(run) && typeof run.chatId === "string" && run.chatId) {
        taskIdByChatId.set(run.chatId, task.id);
      }
    }
  }
  for (const chat of chats) {
    if (chat.taskId === null && taskIdByChatId.has(chat.id)) {
      chat.taskId = taskIdByChatId.get(chat.id);
    }
  }
}

function loadTasksFromRelationalDatabase(database) {
  if (!tableExists(database, "tasks")) {
    return [];
  }

  return database
    .prepare("SELECT * FROM tasks ORDER BY sort_order, created_at, id")
    .all()
    .map((row) => ({
      ...getMetadataObject(row.payload),
      createdAt: row.created_at,
      id: row.id,
      projectId: row.project_id,
      step: row.step,
      title: row.title,
      updatedAt: row.updated_at,
    }));
}

/**
 * A project's legacy step settings, passed through so the renderer can seed the
 * app-wide config from them once. Empty after that config has been saved.
 */
function getNestedTaskConfig(parent) {
  const record = isRecord(parent) ? parent : null;
  const value = isRecord(record?.taskConfig)
    ? record.taskConfig
    : record?.pipelineConfig;
  return isRecord(value) ? value : {};
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

function buildProjectMetadata(
  project,
  { retireProjectTaskConfig = false } = {},
) {
  const metadata = { ...getMetadataObject(project.metadata) };
  delete metadata.mcpServerOverrides;
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
  ui.stashItems = getNestedStashItems(
    Object.hasOwn(projectUi, "stashItems") ? projectUi : ui,
  );
  // Tasks moved to their own table, which is written in the same save (see
  // `getTasksToPersist`), so the per-project copies are retired here.
  delete ui.tasks;
  // Step settings used to be stored on every project. They are a single
  // app-level `taskConfig` config key now, and the per-project copies are only
  // retired by a save that writes that key, so they survive until the app-wide
  // config has been seeded from them.
  if (retireProjectTaskConfig) {
    delete ui.pipelineConfig;
    delete ui.taskConfig;
  }
  // Drop retired feature data carried by older project metadata. The workspace
  // view moved to the app-level `appView` config key, which is written in the
  // same save.
  delete ui.goals;
  delete ui.kanbanCards;
  delete ui.pipelineTasks;
  delete ui.workspaceView;
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
  const branchedFrom =
    chat.branchedFrom &&
    typeof chat.branchedFrom === "object" &&
    typeof chat.branchedFrom.chatId === "string" &&
    chat.branchedFrom.chatId.trim() &&
    typeof chat.branchedFrom.messageId === "string" &&
    chat.branchedFrom.messageId.trim()
      ? {
          chatId: chat.branchedFrom.chatId,
          messageId: chat.branchedFrom.messageId,
        }
      : null;
  const permissions = {
    ...getNestedRecord(metadata, "permissions"),
    mode: normalizeChatPermissionMode(
      chat.permissionMode ??
        getNestedString(getNestedRecord(metadata, "permissions"), "mode", null),
      chat.agentMode ??
        getNestedString(
          getNestedRecord(metadata, "modelSelection"),
          "agentMode",
          "build",
        ),
    ),
  };
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
  const { agentMode: _legacyAgentMode, ...savedModelSelection } =
    getNestedRecord(metadata, "modelSelection");
  const modelSelection = {
    ...savedModelSelection,
    model: typeof chat.model === "string" ? chat.model : "",
    modelSpeed:
      typeof chat.modelSpeed === "string" ? chat.modelSpeed : "standard",
    provider: typeof chat.provider === "string" ? chat.provider : "openai",
    reasoningEffort:
      typeof chat.reasoningEffort === "string" ? chat.reasoningEffort : null,
  };

  return {
    ...metadata,
    branchedFrom,
    messageCount:
      Number.isInteger(chat.messageCount) && chat.messageCount >= 0
        ? chat.messageCount
        : 0,
    modelSelection,
    permissions,
    remoteConversation,
    sparklesPalette: normalizeSparklesPaletteName(
      chat.sparklesPalette ?? metadata.sparklesPalette,
    ),
  };
}

function saveChatMessagesToRelationalDatabase(
  database,
  chatId,
  messages,
  now = new Date().toISOString(),
) {
  if (
    typeof chatId !== "string" ||
    !chatId.trim() ||
    !Array.isArray(messages)
  ) {
    return false;
  }

  const chatExists = database
    .prepare("SELECT 1 FROM chats WHERE id = ? LIMIT 1")
    .get(chatId);
  if (!chatExists) {
    return false;
  }

  const upsertMessage = database.prepare(
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
      ON CONFLICT(id) DO UPDATE SET
        chat_id = excluded.chat_id,
        role = excluded.role,
        sort_order = excluded.sort_order,
        payload = excluded.payload,
        metadata = excluded.metadata
    `,
  );
  const persistedMessageIds = [];

  messages.forEach((message, index) => {
    if (!isRecord(message)) {
      return;
    }

    const messageId =
      typeof message.id === "string" && message.id.trim()
        ? message.id
        : `message-${index}`;
    const persistedMessageId = `${chatId}:${index}:${messageId}`;
    persistedMessageIds.push(persistedMessageId);
    upsertMessage.run(
      persistedMessageId,
      chatId,
      typeof message.role === "string" ? message.role : "",
      index,
      toJson(message),
      toJson({}),
      now,
    );
  });

  // Remove only stale rows belonging to this dirty chat. Other transcripts
  // are deliberately untouched, including chats not loaded by the renderer.
  if (persistedMessageIds.length === 0) {
    database.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
  } else {
    database
      .prepare(
        `DELETE FROM chat_messages
         WHERE chat_id = ?
           AND id NOT IN (${persistedMessageIds.map(() => "?").join(", ")})`,
      )
      .run(chatId, ...persistedMessageIds);
  }

  return true;
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

    const settings = isRecord(state.settings) ? state.settings : {};
    writeConfig(
      database,
      "activeProjectId",
      state.activeProjectId ?? null,
      now,
    );
    writeConfig(database, "chatSort", state.chatSort ?? "recent", now);
    writeConfig(database, "appView", getAppView(state.appView), now);
    writeConfig(
      database,
      "tasksProjectId",
      getTasksProjectId(state.tasksProjectId),
      now,
    );
    if (isRecord(state.taskConfig)) {
      writeConfig(database, "taskConfig", state.taskConfig, now);
    }
    writeConfig(
      database,
      "tasksChatPanelWidth",
      getTasksChatPanelWidth(state.tasksChatPanelWidth),
      now,
    );
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
      "settings.grokSelectedModels",
      Array.isArray(settings.grokSelectedModels)
        ? settings.grokSelectedModels
        : [],
      now,
    );
    writeConfig(
      database,
      "settings.archiveChatsAfterDays",
      Number.isInteger(settings.archiveChatsAfterDays) &&
        settings.archiveChatsAfterDays > 0
        ? settings.archiveChatsAfterDays
        : 30,
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
    writeConfig(
      database,
      "settings.mcpServers",
      normalizeMcpServerList(settings.mcpServers),
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

    // A chat can move to another project: removing a task's worktree hands
    // its step chats to the task's own project. `chats.project_id` cascades,
    // so the stored row must follow before its old project is deleted below,
    // or the delete takes the chat and its whole transcript with it. The new
    // project may only be inserted further down, so the foreign key is
    // checked at commit rather than here (the pragma ends with the
    // transaction).
    const chats = Array.isArray(state.chats) ? state.chats : [];
    const projectIdsToPersist = new Set(
      projectsToPersist.map(({ project }) => project.id),
    );
    database.exec("PRAGMA defer_foreign_keys = ON");
    const moveChat = database.prepare(
      "UPDATE chats SET project_id = ? WHERE id = ? AND project_id <> ?",
    );
    for (const chat of chats) {
      if (
        isRecord(chat) &&
        typeof chat.id === "string" &&
        typeof chat.projectId === "string" &&
        projectIdsToPersist.has(chat.projectId)
      ) {
        moveChat.run(chat.projectId, chat.id, chat.projectId);
      }
    }

    if (projectsToPersist.length === 0) {
      database.prepare("DELETE FROM projects").run();
    } else {
      database
        .prepare(
          `DELETE FROM projects WHERE id NOT IN (${projectsToPersist
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...projectsToPersist.map(({ project }) => project.id));
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
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          normalized_path = excluded.normalized_path,
          name = excluded.name,
          status = excluded.status,
          sort_order = excluded.sort_order,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `,
    );

    projectsToPersist.forEach(({ project, status }, index) => {
      const projectPath = typeof project.path === "string" ? project.path : "";
      const metadata = buildProjectMetadata(project, {
        retireProjectTaskConfig: isRecord(state.taskConfig),
      });

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
    const tasksToPersist = getTasksToPersist(
      state,
      projectsToPersist.map(({ project }) => project),
    );
    if (tasksToPersist) {
      saveTasksToRelationalDatabase(
        database,
        tasksToPersist,
        knownProjectIds,
        now,
      );
    }

    const messagesByChatId = isRecord(state.messagesByChatId)
      ? state.messagesByChatId
      : {};
    const insertChat = database.prepare(
      `
        INSERT INTO chats (
          id,
          project_id,
          task_id,
          title,
          metadata,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          task_id = excluded.task_id,
          title = excluded.title,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
    );
    const persistedChatIds = [];

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
        getChatTaskId(chat.taskId),
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
      persistedChatIds.push(chat.id);

      if (
        Object.hasOwn(messagesByChatId, chat.id) &&
        Array.isArray(messagesByChatId[chat.id])
      ) {
        saveChatMessagesToRelationalDatabase(
          database,
          chat.id,
          messagesByChatId[chat.id],
          now,
        );
      }
    }

    if (persistedChatIds.length === 0) {
      database.prepare("DELETE FROM chats").run();
    } else {
      database
        .prepare(
          `DELETE FROM chats WHERE id NOT IN (${persistedChatIds
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...persistedChatIds);
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
  const legacyTasksProjectIds = new Set();
  for (const row of projectRows) {
    const metadata = getMetadataObject(row.metadata);
    delete metadata.mcpServerOverrides;
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
      stashItems: getNestedStashItems(ui),
      taskConfig: getNestedTaskConfig(ui),
    };
    if (isLegacyTasksWorkspaceView(ui.workspaceView)) {
      legacyTasksProjectIds.add(project.id);
    }
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
        SELECT chats.*, COUNT(chat_messages.id) AS message_count
        FROM chats
        LEFT JOIN chat_messages ON chat_messages.chat_id = chats.id
        GROUP BY chats.id
        ORDER BY chats.created_at, chats.id
      `,
    )
    .all();

  for (const row of chatRows) {
    const metadata = getMetadataObject(row.metadata);
    const modelSelection = getNestedRecord(metadata, "modelSelection");
    const permissions = getNestedRecord(metadata, "permissions");
    const remoteConversation = getNestedRecord(metadata, "remoteConversation");
    const branchedFrom = getNestedRecord(metadata, "branchedFrom");

    chats.push({
      branchedFrom:
        getNestedString(branchedFrom, "chatId", "").trim() &&
        getNestedString(branchedFrom, "messageId", "").trim()
          ? {
              chatId: getNestedString(branchedFrom, "chatId", ""),
              messageId: getNestedString(branchedFrom, "messageId", ""),
            }
          : null,
      createdAt: row.created_at,
      deletedAt:
        typeof row.deleted_at === "string" && row.deleted_at.trim()
          ? row.deleted_at
          : null,
      id: row.id,
      messageCount:
        typeof row.message_count === "number" ? row.message_count : 0,
      metadata,
      model: getNestedString(modelSelection, "model", ""),
      modelSpeed: getNestedString(modelSelection, "modelSpeed", "standard"),
      permissionMode:
        getNestedString(permissions, "mode", null) == null
          ? null
          : normalizeChatPermissionMode(
              getNestedString(permissions, "mode", null),
              getNestedString(modelSelection, "agentMode", "build"),
            ),
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
      taskId: getChatTaskId(row.task_id),
      title: row.title || "New chat",
      updatedAt: row.updated_at,
    });
  }

  // Transcripts are loaded per chat when a panel first opens.
  const messagesByChatId = {};

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

  // Tasks still stored on their projects are folded into the app-wide list;
  // the next save writes them to the table and retires the copies.
  const tasks = appendLegacyProjectTasks(
    loadTasksFromRelationalDatabase(database),
    allProjects,
  );
  backfillChatTaskIds(chats, tasks);
  for (const project of allProjects) {
    const metadataUi = getNestedRecord(project.metadata, "ui");
    for (const key of LEGACY_PROJECT_TASK_KEYS) {
      delete metadataUi[key];
    }
  }

  const activeProjectId =
    typeof config.activeProjectId === "string" ? config.activeProjectId : null;
  return {
    activeProjectId,
    tasks,
    appView: getAppView(
      config.appView,
      activeProjectId && legacyTasksProjectIds.has(activeProjectId)
        ? "tasks"
        : "code",
    ),
    tasksProjectId: getTasksProjectId(
      config.tasksProjectId ?? config.pipelineProjectId,
    ),
    tasksChatPanelWidth: getTasksChatPanelWidth(config.tasksChatPanelWidth),
    // Absent until first saved; the renderer then seeds it from the legacy
    // per-project configs passed through on each project's `ui.taskConfig`.
    taskConfig: isRecord(config.taskConfig) ? config.taskConfig : null,
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
      archiveChatsAfterDays:
        Number.isInteger(config["settings.archiveChatsAfterDays"]) &&
        config["settings.archiveChatsAfterDays"] > 0
          ? config["settings.archiveChatsAfterDays"]
          : Number.isInteger(config["settings.autoArchiveChatsAfterDays"]) &&
              config["settings.autoArchiveChatsAfterDays"] > 0
            ? config["settings.autoArchiveChatsAfterDays"]
            : 30,
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
      grokSelectedModels: Array.isArray(config["settings.grokSelectedModels"])
        ? config["settings.grokSelectedModels"]
        : [],
      mcpServers: normalizeMcpServerList(config["settings.mcpServers"]),
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

function getStateDatabase(databasePath = resolveStateDatabasePath()) {
  const resolvedDatabasePath =
    resolveConfiguredStateDatabasePath(databasePath) ??
    resolveStateDatabasePath();

  if (stateDatabase && stateDatabasePath === resolvedDatabasePath) {
    return stateDatabase;
  }

  closePersistedStateDatabase();

  mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  const database = new DatabaseSync(resolvedDatabasePath);
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
  stateDatabasePath = resolvedDatabasePath;
  return database;
}

export function getPersistedStateDatabase({ databasePath } = {}) {
  return getStateDatabase(databasePath);
}

export function savePersistedState(state, { databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  return saveStateToRelationalDatabase(database, state);
}

export function savePersistedChatMessages(
  { chatId, messages } = {},
  { databasePath } = {},
) {
  const database = getStateDatabase(databasePath);
  return runInTransaction(database, () =>
    saveChatMessagesToRelationalDatabase(database, chatId, messages),
  );
}

export function savePersistedActiveProject(
  { activeProjectId, lastUsedAt } = {},
  { databasePath } = {},
) {
  const database = getStateDatabase(databasePath);
  const normalizedActiveProjectId =
    typeof activeProjectId === "string" && activeProjectId.trim()
      ? activeProjectId.trim()
      : null;
  const normalizedLastUsedAt =
    typeof lastUsedAt === "string" && Number.isFinite(Date.parse(lastUsedAt))
      ? lastUsedAt
      : null;
  const now = new Date().toISOString();

  return runInTransaction(database, () => {
    writeConfig(database, "activeProjectId", normalizedActiveProjectId, now);

    if (!normalizedActiveProjectId || !normalizedLastUsedAt) {
      return true;
    }

    const row = database
      .prepare("SELECT metadata FROM projects WHERE id = ? LIMIT 1")
      .get(normalizedActiveProjectId);
    if (!row) {
      return true;
    }

    database
      .prepare(
        `
          UPDATE projects
          SET metadata = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        toJson({
          ...getMetadataObject(row.metadata),
          lastUsedAt: normalizedLastUsedAt,
        }),
        now,
        normalizedActiveProjectId,
      );

    return true;
  });
}

export function loadPersistedState({ databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  return loadStateFromRelationalDatabase(database);
}

export function loadPersistedChatMessages(chatId, { databasePath } = {}) {
  if (typeof chatId !== "string" || !chatId.trim()) {
    return [];
  }

  const database = getStateDatabase(databasePath);
  return database
    .prepare(
      `
        SELECT payload
        FROM chat_messages
        WHERE chat_id = ?
        ORDER BY sort_order, id
      `,
    )
    .all(chatId)
    .flatMap((row) => {
      const payload = parseJson(row.payload, null);
      return isRecord(payload) ? [payload] : [];
    });
}

export function ensurePersistedInstallId({ databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  const row = database
    .prepare("SELECT value FROM config WHERE key = ? LIMIT 1")
    .get(INSTALL_ID_CONFIG_KEY);
  const existingInstallId = parseJson(row?.value, null);
  if (isUuidV4(existingInstallId)) {
    return existingInstallId.toLowerCase();
  }

  const installId = randomUUID();
  writeConfig(
    database,
    INSTALL_ID_CONFIG_KEY,
    installId,
    new Date().toISOString(),
  );
  return installId;
}

export function loadPersistedThemePreference({ databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  const row = database
    .prepare("SELECT value FROM config WHERE key = ? LIMIT 1")
    .get(THEME_PREFERENCES_CONFIG_KEY);
  const preferences = parseJson(row?.value, null);
  return isRecord(preferences) ? preferences : null;
}

export function savePersistedThemePreference(
  preferences,
  { databasePath } = {},
) {
  if (!isRecord(preferences)) {
    return false;
  }

  const database = getStateDatabase(databasePath);
  writeConfig(
    database,
    THEME_PREFERENCES_CONFIG_KEY,
    preferences,
    new Date().toISOString(),
  );
  return true;
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
  stateDatabasePath = null;
}
