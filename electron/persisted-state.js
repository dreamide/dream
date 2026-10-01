// SQLite storage for persisted state.
//
// This module is I/O only: opening the database, migrations, transactions and
// the rows. What a project, a chat or a setting looks like, what deserves to
// be saved, and how a stored value is repaired on load are all decided by the
// shared codec (./shared/persisted-state-codec.js), which the renderer uses
// too. Save writes what it is given; load decodes once, so the renderer
// receives a valid state.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { requireHostDataDirectory } from "./host/host-paths.js";
import {
  chatFromRow,
  chatToRow,
  createEmptyPersistedState,
  decodePersistedState,
  encodePersistedState,
  projectFromRow,
  projectToRow,
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
  if (!isRecord(state)) {
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

    for (const [key, value] of Object.entries(stateToConfig(state))) {
      writeConfig(database, key, value, now);
    }

    const projectRows = [];
    const seenProjectIds = new Set();
    const seenProjectPaths = new Set();
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
          !project.id.trim()
        ) {
          continue;
        }

        const row = projectToRow(project, status, projectRows.length);
        if (
          seenProjectIds.has(row.id) ||
          seenProjectPaths.has(row.normalizedPath)
        ) {
          continue;
        }

        seenProjectIds.add(row.id);
        seenProjectPaths.add(row.normalizedPath);
        projectRows.push(row);
      }
    }

    // A chat can move to another project. `chats.project_id` cascades,
    // so the stored row must follow before its old project is deleted below,
    // or the delete takes the chat and its whole transcript with it. The new
    // project may only be inserted further down, so the foreign key is
    // checked at commit rather than here (the pragma ends with the
    // transaction).
    const chats = Array.isArray(state.chats) ? state.chats : [];
    database.exec("PRAGMA defer_foreign_keys = ON");
    const moveChat = database.prepare(
      "UPDATE chats SET project_id = ? WHERE id = ? AND project_id <> ?",
    );
    for (const chat of chats) {
      if (
        isRecord(chat) &&
        typeof chat.id === "string" &&
        typeof chat.projectId === "string" &&
        seenProjectIds.has(chat.projectId)
      ) {
        moveChat.run(chat.projectId, chat.id, chat.projectId);
      }
    }

    if (projectRows.length === 0) {
      database.prepare("DELETE FROM projects").run();
    } else {
      database
        .prepare(
          `DELETE FROM projects WHERE id NOT IN (${projectRows
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...projectRows.map((row) => row.id));
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
    for (const row of projectRows) {
      insertProject.run(
        row.id,
        row.path,
        row.normalizedPath,
        row.name,
        row.status,
        row.sortOrder,
        toJson(row.metadata),
        existingProjectCreatedAt.get(row.id) ?? now,
        now,
      );
    }

    // A state that says nothing about saved prompts leaves them alone.
    if (Array.isArray(state.savedPrompts)) {
      saveSavedPromptsToRelationalDatabase(database, state.savedPrompts, now);
    }

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
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
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
        !chat.id.trim() ||
        !seenProjectIds.has(chat.projectId)
      ) {
        continue;
      }

      const row = chatToRow(chat);
      const createdAt =
        row.createdAt ?? existingChatCreatedAt.get(row.id) ?? now;
      insertChat.run(
        row.id,
        row.projectId,
        row.title,
        toJson(row.metadata),
        createdAt,
        row.updatedAt ?? createdAt,
        row.deletedAt,
      );
      persistedChatIds.push(row.id);

      // A transcript key is present only when the renderer has it loaded.
      if (Array.isArray(messagesByChatId[row.id])) {
        saveChatMessagesToRelationalDatabase(
          database,
          row.id,
          messagesByChatId[row.id],
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
    return createEmptyPersistedState();
  }

  const projects = [];
  const closedProjects = [];
  for (const row of projectRows) {
    const project = projectFromRow({
      ...row,
      metadata: getMetadataObject(row.metadata),
    });
    (row.status === "closed" ? closedProjects : projects).push(project);
  }

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
  const chats = chatRows.map((row) =>
    chatFromRow({ ...row, metadata: getMetadataObject(row.metadata) }),
  );

  return decodePersistedState({
    ...stateFromConfig(config),
    chats,
    closedProjects,
    // Transcripts are loaded per chat when a panel first opens.
    messagesByChatId: {},
    projects,
    savedPrompts: loadSavedPromptsFromRelationalDatabase(database),
  });
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
  // The pre-relational blob goes through the codec like any other input.
  // It may predate saved prompts; a state that lacks them leaves the table
  // alone rather than emptying it.
  const encoded = encodePersistedState(decodePersistedState(legacyState));
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
