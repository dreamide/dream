// SQLite storage for persisted state.
//
// This module is I/O only: opening the database, migrations, transactions and
// the rows. What a project, a chat or a setting looks like, what deserves to
// be saved, and how a stored value is repaired on load are all decided by the
// shared codec (./shared/persisted-state-codec.js), which the renderer uses
// too.
//
// One database holds two owners' rows. The client's **workspace** (config,
// saved prompts, `workspace_projects`) is saved whole from the renderer's
// state. The host's **catalog** (`projects`, `chats`, `chat_messages`) is
// written only by the host, a change at a time (host/catalog-store.js). The
// local host and the client share this file; a daemon's has only a catalog.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  applyCatalogChanges,
  loadCatalog,
  loadChat,
  loadChatMessages,
  saveChatMessages,
} from "./host/catalog-store.js";
import { requireHostDataDirectory } from "./host/host-paths.js";
import {
  decodePersistedState,
  encodePersistedState,
  LOCAL_HOST_ID,
  projectToWorkspaceRow,
  stateFromConfig,
  stateToConfig,
} from "./shared/persisted-state-codec.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

const RELATIONAL_SCHEMA_VERSION = 2;
const STATE_DB_FILENAME = "dream.db";
const STATE_DB_PATH_ENV_VAR = "DREAM_DB_PATH";
const DRIZZLE_MIGRATIONS_FOLDER = path.join(__dirname, "drizzle");
const INSTALL_ID_CONFIG_KEY = "installId";
const THEME_PREFERENCES_CONFIG_KEY = "themePreferences";
let stateDatabase = null;
let stateDatabasePath = null;

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

  // Workers must set DREAM_DB_PATH (the save worker always does): the host
  // data directory is configured per thread, so this branch never runs there.
  return path.join(requireHostDataDirectory(), STATE_DB_FILENAME);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function saveSavedPromptsToRelationalDatabase(database, savedPrompts, now) {
  const existingCreatedAt = new Map(
    database
      .prepare("SELECT id, created_at FROM saved_prompts")
      .all()
      .map((row) => [row.id, row.created_at]),
  );
  const insertSavedPrompt = database.prepare(
    `
      INSERT INTO saved_prompts (id, name, prompt, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        prompt = excluded.prompt,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `,
  );
  const persistedIds = [];

  for (const savedPrompt of savedPrompts) {
    if (
      !isRecord(savedPrompt) ||
      typeof savedPrompt.id !== "string" ||
      !savedPrompt.id.trim() ||
      typeof savedPrompt.prompt !== "string" ||
      persistedIds.includes(savedPrompt.id)
    ) {
      continue;
    }

    const createdAt =
      nonEmptyString(savedPrompt.createdAt) ??
      existingCreatedAt.get(savedPrompt.id) ??
      now;
    insertSavedPrompt.run(
      savedPrompt.id,
      typeof savedPrompt.name === "string" ? savedPrompt.name : "",
      savedPrompt.prompt,
      persistedIds.length,
      createdAt,
      nonEmptyString(savedPrompt.updatedAt) ?? createdAt,
    );
    persistedIds.push(savedPrompt.id);
  }

  if (persistedIds.length === 0) {
    database.prepare("DELETE FROM saved_prompts").run();
  } else {
    database
      .prepare(
        `DELETE FROM saved_prompts WHERE id NOT IN (${persistedIds
          .map(() => "?")
          .join(", ")})`,
      )
      .run(...persistedIds);
  }
}

function loadSavedPromptsFromRelationalDatabase(database) {
  if (!tableExists(database, "saved_prompts")) {
    return [];
  }

  return database
    .prepare("SELECT * FROM saved_prompts ORDER BY sort_order, created_at, id")
    .all()
    .map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      updatedAt: row.updated_at,
    }));
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

/**
 * Saves the client's workspace from the renderer's (encoded) state: config,
 * saved prompts, and a workspace row per open and closed project, on
 * whichever host. The catalog rows are the hosts' and are not touched.
 *
 * `state.describedHostIds` are the hosts whose projects the state describes
 * completely (by default the local host). A project of another host (an SSH
 * host not loaded this session, shown from its snapshot) only moves: its
 * status and place are saved, while its UI and snapshot stay as last saved
 * by a window that had its chats. One with no row yet gets a whole one.
 */
function saveStateToRelationalDatabase(database, state) {
  if (!isRecord(state)) {
    return false;
  }

  const now = new Date().toISOString();

  return runInTransaction(database, () => {
    for (const [key, value] of Object.entries(stateToConfig(state))) {
      writeConfig(database, key, value, now);
    }

    // A state that says nothing about saved prompts leaves them alone.
    if (Array.isArray(state.savedPrompts)) {
      saveSavedPromptsToRelationalDatabase(database, state.savedPrompts, now);
    }

    const describedHostIds = Array.isArray(state.describedHostIds)
      ? state.describedHostIds.filter((id) => typeof id === "string")
      : [LOCAL_HOST_ID];
    const described = new Set(describedHostIds);

    const rows = [];
    const seen = new Set();
    for (const [status, projects] of [
      ["open", Array.isArray(state.projects) ? state.projects : []],
      [
        "closed",
        Array.isArray(state.closedProjects) ? state.closedProjects : [],
      ],
    ]) {
      for (const project of projects) {
        if (
          !isRecord(project) ||
          typeof project.id !== "string" ||
          !project.id.trim() ||
          seen.has(project.id)
        ) {
          continue;
        }
        seen.add(project.id);
        rows.push(projectToWorkspaceRow(project, status, rows.length));
      }
    }

    const upsert = database.prepare(
      `
        INSERT INTO workspace_projects (
          host_id, project_id, status, sort_order, ui, last_used_at,
          snapshot, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id, project_id) DO UPDATE SET
          status = excluded.status,
          sort_order = excluded.sort_order,
          ui = excluded.ui,
          last_used_at = excluded.last_used_at,
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at
      `,
    );
    // A project of a host this save does not describe: a row it already
    // has only moves (its UI and snapshot were saved by a window that had
    // the host's chats); a project with no row yet gets one.
    const move = database.prepare(
      `
        INSERT INTO workspace_projects (
          host_id, project_id, status, sort_order, ui, last_used_at,
          snapshot, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id, project_id) DO UPDATE SET
          status = excluded.status,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `,
    );
    for (const row of rows) {
      if (!described.has(row.hostId)) {
        move.run(
          row.hostId,
          row.projectId,
          row.status,
          row.sortOrder,
          toJson(row.ui),
          row.lastUsedAt,
          toJson(row.snapshot),
          now,
        );
        continue;
      }
      upsert.run(
        row.hostId,
        row.projectId,
        row.status,
        row.sortOrder,
        toJson(row.ui),
        row.lastUsedAt,
        toJson(row.snapshot),
        now,
      );
    }

    // This save describes the projects of these hosts completely; a host it
    // says nothing about (one not connected this session) keeps its rows.
    for (const hostId of describedHostIds) {
      const kept = rows
        .filter((row) => row.hostId === hostId)
        .map((row) => row.projectId);
      const keptClause =
        kept.length > 0
          ? ` AND project_id NOT IN (${kept.map(() => "?").join(", ")})`
          : "";
      database
        .prepare(
          `DELETE FROM workspace_projects WHERE host_id = ?${keptClause}`,
        )
        .run(hostId, ...kept);
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

/**
 * The client's workspace: the top-level state from config, saved prompts,
 * and every workspace row (of every host). The renderer merges it with each
 * host's catalog (codec mergeWorkspaceAndCatalog).
 */
function loadWorkspaceFromRelationalDatabase(database) {
  const workspaceProjects = database
    .prepare(
      `
        SELECT *
        FROM workspace_projects
        ORDER BY host_id, status = 'closed', sort_order
      `,
    )
    .all()
    .map((row) => ({
      hostId: row.host_id,
      lastUsedAt: row.last_used_at,
      projectId: row.project_id,
      snapshot: parseJson(row.snapshot, {}),
      sortOrder: row.sort_order,
      status: row.status === "closed" ? "closed" : "open",
      ui: parseJson(row.ui, {}),
    }));

  return {
    ...stateFromConfig(readConfig(database)),
    savedPrompts: loadSavedPromptsFromRelationalDatabase(database),
    workspaceProjects,
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

function importLegacyState(database, legacyState) {
  // The pre-relational blob goes through the codec like any other input,
  // then splits: its projects, chats and transcripts become the local
  // host's catalog, the rest this client's workspace. It may predate saved
  // prompts; a state that lacks them leaves the table alone.
  const encoded = encodePersistedState(decodePersistedState(legacyState));
  const now = new Date().toISOString();
  runInTransaction(database, () => {
    applyCatalogChanges(
      database,
      {
        chats: encoded.chats,
        projects: [...encoded.projects, ...encoded.closedProjects],
      },
      now,
    );
    for (const [chatId, messages] of Object.entries(encoded.messagesByChatId)) {
      saveChatMessages(database, chatId, messages, now);
    }
  });
  saveStateToRelationalDatabase(
    database,
    Array.isArray(legacyState.savedPrompts)
      ? encoded
      : { ...encoded, savedPrompts: undefined },
  );
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
    PRAGMA busy_timeout = 5000;
  `);
  const hadRelationalState = hasRelationalState(database);
  runDrizzleMigrations(database);

  if (shouldImportLegacyState(database, legacyState, hadRelationalState)) {
    importLegacyState(database, legacyState);
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
    saveChatMessages(database, chatId, messages, new Date().toISOString()),
  );
}

/** The host catalog: every project and chat, raw. */
export function loadPersistedCatalog({ databasePath } = {}) {
  return loadCatalog(getStateDatabase(databasePath));
}

/** One catalog chat, raw, or null. */
export function loadPersistedChat(chatId, { databasePath } = {}) {
  return loadChat(getStateDatabase(databasePath), chatId);
}

/** Applies one catalog change set; see host/catalog-store.js. */
export function applyPersistedCatalogChanges(changes, { databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  return runInTransaction(database, () =>
    applyCatalogChanges(
      database,
      isRecord(changes) ? changes : {},
      new Date().toISOString(),
    ),
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

    database
      .prepare(
        `
          UPDATE workspace_projects
          SET last_used_at = ?, updated_at = ?
          WHERE host_id = ? AND project_id = ?
        `,
      )
      .run(normalizedLastUsedAt, now, LOCAL_HOST_ID, normalizedActiveProjectId);

    return true;
  });
}

/** The client's workspace (see loadWorkspaceFromRelationalDatabase). */
export function loadPersistedState({ databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  return loadWorkspaceFromRelationalDatabase(database);
}

export function loadPersistedChatMessages(chatId, { databasePath } = {}) {
  return loadChatMessages(getStateDatabase(databasePath), chatId);
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
