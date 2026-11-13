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
//
// One connection writes: the save worker's (state-save-queue.js), which is
// also the first to open the file and so the one that migrates it. Readers
// on other threads (state-read-pool.js) open it with
// `openPersistedStateReader` and never write.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  applyCatalogChanges,
  loadCatalog,
  loadChatMessages,
  saveChatMessages,
  searchChatMessages,
} from "./host/catalog-store.js";
import { requireHostDataDirectory } from "./host/host-paths.js";
import {
  decodePersistedState,
  encodePersistedState,
  stateFromConfig,
  stateToConfig,
  workspaceRowsOf,
} from "./shared/persisted-state-codec.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

const RELATIONAL_SCHEMA_VERSION = 2;
const STATE_DB_FILENAME = "dream.db";
const STATE_DB_PATH_ENV_VAR = "DREAM_DB_PATH";
const DRIZZLE_MIGRATIONS_FOLDER = path.join(__dirname, "drizzle");
const BUSY_TIMEOUT_MS = 5000;
// The WAL is truncated back to this after a checkpoint; a long turn's
// transcript saves would otherwise leave it at its high-water mark.
const JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;
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
 * Writers for `workspace_projects` rows. `upsert` writes a whole row;
 * `move` only moves a row that exists (status and place: its UI and
 * snapshot were saved by a window that had its host's chats), and writes a
 * whole one where there is none yet.
 */
function workspaceRowWriters(database, now) {
  const statement = (onConflict) =>
    database.prepare(
      `
        INSERT INTO workspace_projects (
          host_id, project_id, status, sort_order, ui, last_used_at,
          snapshot, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id, project_id) DO UPDATE SET ${onConflict}
      `,
    );
  const upsert = statement(`
    status = excluded.status,
    sort_order = excluded.sort_order,
    ui = excluded.ui,
    last_used_at = excluded.last_used_at,
    snapshot = excluded.snapshot,
    updated_at = excluded.updated_at
  `);
  const move = statement(`
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = excluded.updated_at
  `);
  const write = (prepared) => (row) =>
    prepared.run(
      row.hostId,
      row.projectId,
      row.status,
      row.sortOrder,
      toJson(row.ui),
      row.lastUsedAt,
      toJson(row.snapshot),
      now,
    );
  return { move: write(move), upsert: write(upsert) };
}

const isWorkspaceRow = (row) =>
  isRecord(row) &&
  typeof row.hostId === "string" &&
  row.hostId.trim() !== "" &&
  typeof row.projectId === "string" &&
  row.projectId.trim() !== "" &&
  (row.status === "open" || row.status === "closed") &&
  Number.isInteger(row.sortOrder) &&
  (row.lastUsedAt === null || typeof row.lastUsedAt === "string");

/**
 * Saves what changed in the client's workspace, as the renderer worked it
 * out (store/workspace-save.ts): only the config keys, saved prompts and
 * `workspace_projects` rows that differ from its last save. Rows of a host
 * the renderer does not describe come as `moveRows`. It is the
 * `workspace-changes` write (state-writes.js), which runs it in a
 * transaction.
 */
export function saveWorkspaceChanges(database, changes) {
  if (!isRecord(changes)) {
    return false;
  }

  const now = new Date().toISOString();
  const config = isRecord(changes.config) ? changes.config : {};
  for (const [key, value] of Object.entries(config)) {
    writeConfig(database, key, value, now);
  }

  if (Array.isArray(changes.savedPrompts)) {
    saveSavedPromptsToRelationalDatabase(database, changes.savedPrompts, now);
  }

  const { move, upsert } = workspaceRowWriters(database, now);
  for (const row of Array.isArray(changes.upsertRows)
    ? changes.upsertRows
    : []) {
    if (isWorkspaceRow(row)) upsert(row);
  }
  for (const row of Array.isArray(changes.moveRows) ? changes.moveRows : []) {
    if (isWorkspaceRow(row)) move(row);
  }

  const remove = database.prepare(
    "DELETE FROM workspace_projects WHERE host_id = ? AND project_id = ?",
  );
  for (const row of Array.isArray(changes.removeRows)
    ? changes.removeRows
    : []) {
    if (
      isRecord(row) &&
      typeof row.hostId === "string" &&
      typeof row.projectId === "string"
    ) {
      remove.run(row.hostId, row.projectId);
    }
  }
  return true;
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

  // The last migration is read inside the write transaction, so a second
  // connection opening the file at the same moment waits for this one and
  // then finds nothing left to apply.
  database.exec("BEGIN IMMEDIATE");

  try {
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
  // The workspace goes in as one change set over an empty workspace, the
  // same writer and row rule every later save uses.
  runInTransaction(database, () =>
    saveWorkspaceChanges(database, {
      config: stateToConfig(encoded),
      ...(Array.isArray(legacyState.savedPrompts)
        ? { savedPrompts: encoded.savedPrompts }
        : {}),
      upsertRows: workspaceRowsOf(encoded),
    }),
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
  // NORMAL is durable in WAL mode except across a power loss, where the
  // last commits may roll back; the database stays consistent either way.
  database.exec(`
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES};
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

/**
 * A connection that only reads, for a reader thread (state-read-pool.js).
 * It neither migrates nor imports: the writer has opened the file first.
 * In WAL mode it reads beside the writer without waiting for it, each read
 * seeing the last commit before it began.
 * @param {string} databasePath
 */
export function openPersistedStateReader(databasePath) {
  const resolvedDatabasePath = resolveConfiguredStateDatabasePath(databasePath);
  if (!resolvedDatabasePath) {
    throw new Error("A state reader needs the database path.");
  }
  const database = new DatabaseSync(resolvedDatabasePath);
  database.exec(`
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA query_only = ON;
  `);
  return database;
}

/**
 * Writes one config value, as is (JSON), outside any other change: the
 * theme preference, the install id. The `config` write (state-writes.js).
 */
export function writeConfigValue(database, { key, value } = {}) {
  if (typeof key !== "string" || !key.trim()) {
    return false;
  }
  writeConfig(database, key, value, new Date().toISOString());
  return true;
}

/** The host catalog: every project and chat, raw. */
export function loadPersistedCatalog({ databasePath } = {}) {
  return loadCatalog(getStateDatabase(databasePath));
}

/** The client's workspace (see loadWorkspaceFromRelationalDatabase). */
export function loadPersistedState({ databasePath } = {}) {
  const database = getStateDatabase(databasePath);
  return loadWorkspaceFromRelationalDatabase(database);
}

export function loadPersistedChatMessages(chatId, { databasePath } = {}) {
  return loadChatMessages(getStateDatabase(databasePath), chatId);
}

/** The chats whose transcript says `query`; see host/catalog-store.js. */
export function searchPersistedChatMessages(
  query,
  { databasePath, limit } = {},
) {
  return searchChatMessages(getStateDatabase(databasePath), query, { limit });
}

/**
 * Config values, read on a connection of their own that never writes or
 * migrates: Electron main's reads, which must not wait on the writer or
 * run a migration on the thread that serves the window. Missing keys are
 * absent; so is everything before the writer has created the database.
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
function readConfigValues(keys, { databasePath } = {}) {
  const resolvedDatabasePath =
    resolveConfiguredStateDatabasePath(databasePath) ??
    resolveStateDatabasePath();
  if (!existsSync(resolvedDatabasePath)) {
    return {};
  }

  const database = openPersistedStateReader(resolvedDatabasePath);
  try {
    if (!tableExists(database, "config")) {
      return {};
    }
    const read = database.prepare(
      "SELECT value FROM config WHERE key = ? LIMIT 1",
    );
    const values = {};
    for (const key of keys) {
      const row = read.get(key);
      if (row) values[key] = parseJson(row.value, null);
    }
    return values;
  } finally {
    database.close();
  }
}

/**
 * The install id, and whether it was just made. A new one is not saved
 * here: the caller saves it (`installIdConfigValue`) through the writer.
 * @returns {{ installId: string, created: boolean }}
 */
export function readOrCreatePersistedInstallId({ databasePath } = {}) {
  const existingInstallId = readConfigValues([INSTALL_ID_CONFIG_KEY], {
    databasePath,
  })[INSTALL_ID_CONFIG_KEY];
  if (isUuidV4(existingInstallId)) {
    return { created: false, installId: existingInstallId.toLowerCase() };
  }

  return { created: true, installId: randomUUID() };
}

/** The config write that saves an install id. */
export const installIdConfigValue = (installId) => ({
  key: INSTALL_ID_CONFIG_KEY,
  value: installId,
});

/** The saved theme preferences, or null; read as `readConfigValues` reads. */
export function loadPersistedThemePreference({ databasePath } = {}) {
  const preferences = readConfigValues([THEME_PREFERENCES_CONFIG_KEY], {
    databasePath,
  })[THEME_PREFERENCES_CONFIG_KEY];
  return isRecord(preferences) ? preferences : null;
}

/** The config write that saves theme preferences, or null for a non-record. */
export const themePreferenceConfigValue = (preferences) =>
  isRecord(preferences)
    ? { key: THEME_PREFERENCES_CONFIG_KEY, value: preferences }
    : null;

export function closePersistedStateDatabase() {
  if (!stateDatabase) {
    return;
  }

  stateDatabase.close();
  stateDatabase = null;
  stateDatabasePath = null;
}
