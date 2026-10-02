// The host catalog's rows: projects, chats and transcripts in the host's
// database. I/O only, on an open database handle; what a project or chat
// looks like is the shared codec's business (projectToCatalogRow,
// chatToRow, projectFromRow, chatFromRow).
//
// Writes are granular. A change names the projects and chats it upserts and
// the ids it removes, and nothing else is touched, so two clients editing
// different chats never erase each other's work. Projects are unique by
// path: an upsert whose path already belongs to another project is refused
// and reported as a conflict.
import {
  chatFromRow,
  chatToRow,
  projectFromRow,
  projectToCatalogRow,
} from "../shared/persisted-state-codec.js";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toJson = (value) => JSON.stringify(value === undefined ? null : value);

const parseJson = (value, fallback) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const idList = (value) =>
  Array.isArray(value)
    ? value.filter((id) => typeof id === "string" && id.trim())
    : [];

const placeholders = (values) => values.map(() => "?").join(", ");

/**
 * Every project and chat, raw (decodePersistedState repairs them). Chats
 * carry the live message count.
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function loadCatalog(database) {
  const projects = database
    .prepare("SELECT * FROM projects ORDER BY created_at, id")
    .all()
    .map((row) =>
      projectFromRow(
        { ...row, metadata: parseJson(row.metadata, {}) },
        // Catalog rows carry no workspace fields.
        { lastUsedAt: null, ui: undefined },
      ),
    );
  const chats = database
    .prepare(
      `
        SELECT chats.*, COUNT(chat_messages.id) AS message_count
        FROM chats
        LEFT JOIN chat_messages ON chat_messages.chat_id = chats.id
        GROUP BY chats.id
        ORDER BY chats.created_at, chats.id
      `,
    )
    .all()
    .map((row) =>
      chatFromRow({ ...row, metadata: parseJson(row.metadata, {}) }),
    );
  return { chats, projects };
}

/**
 * One chat, raw, or null.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} chatId
 */
export function loadChat(database, chatId) {
  const row = database
    .prepare("SELECT * FROM chats WHERE id = ? LIMIT 1")
    .get(chatId);
  return row
    ? chatFromRow({ ...row, metadata: parseJson(row.metadata, {}) })
    : null;
}

/**
 * @typedef {{
 *   projects?: unknown[],
 *   removedProjectIds?: unknown[],
 *   chats?: unknown[],
 *   removedChatIds?: unknown[],
 * }} CatalogChanges
 */

/**
 * Applies one change set in one transaction. The caller owns the
 * transaction (persisted-state.js runs it).
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {CatalogChanges} changes
 * @param {string} now
 * @returns {{
 *   projectIds: string[],
 *   chatIds: string[],
 *   removedProjectIds: string[],
 *   removedChatIds: string[],
 *   conflicts: { id: string, existingId: string, path: string }[],
 * }} what was applied, and the projects refused for a taken path
 */
export function applyCatalogChanges(database, changes, now) {
  const result = {
    chatIds: [],
    conflicts: [],
    projectIds: [],
    removedChatIds: [],
    removedProjectIds: [],
  };

  // A chat may arrive with (or move to) a project inserted later in this
  // same change; foreign keys are checked at commit.
  database.exec("PRAGMA defer_foreign_keys = ON");

  const findByPath = database.prepare(
    "SELECT id FROM projects WHERE normalized_path = ? LIMIT 1",
  );
  const upsertProject = database.prepare(
    `
      INSERT INTO projects (
        id, path, normalized_path, name, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        normalized_path = excluded.normalized_path,
        name = excluded.name,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `,
  );
  for (const project of Array.isArray(changes.projects)
    ? changes.projects
    : []) {
    if (!isRecord(project) || typeof project.id !== "string") continue;
    const row = projectToCatalogRow(project);
    if (!row.id.trim() || !row.path) continue;
    const owner = findByPath.get(row.normalizedPath);
    if (owner && owner.id !== row.id) {
      result.conflicts.push({
        existingId: owner.id,
        id: row.id,
        path: row.path,
      });
      continue;
    }
    upsertProject.run(
      row.id,
      row.path,
      row.normalizedPath,
      row.name,
      toJson(row.metadata),
      now,
      now,
    );
    result.projectIds.push(row.id);
  }

  const projectExists = database.prepare(
    "SELECT 1 FROM projects WHERE id = ? LIMIT 1",
  );
  const upsertChat = database.prepare(
    `
      INSERT INTO chats (
        id, project_id, title, metadata, created_at, updated_at, deleted_at
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
  for (const chat of Array.isArray(changes.chats) ? changes.chats : []) {
    if (!isRecord(chat) || typeof chat.id !== "string" || !chat.id.trim()) {
      continue;
    }
    const row = chatToRow(chat);
    if (
      typeof row.projectId !== "string" ||
      !projectExists.get(row.projectId)
    ) {
      continue;
    }
    const createdAt = row.createdAt ?? now;
    upsertChat.run(
      row.id,
      row.projectId,
      row.title,
      toJson(row.metadata),
      createdAt,
      row.updatedAt ?? createdAt,
      row.deletedAt,
    );
    result.chatIds.push(row.id);
  }

  const removedChatIds = idList(changes.removedChatIds);
  if (removedChatIds.length > 0) {
    database
      .prepare(
        `DELETE FROM chats WHERE id IN (${placeholders(removedChatIds)})`,
      )
      .run(...removedChatIds);
    result.removedChatIds = removedChatIds;
  }

  // Removing a project removes its chats and transcripts with it.
  const removedProjectIds = idList(changes.removedProjectIds);
  if (removedProjectIds.length > 0) {
    database
      .prepare(
        `DELETE FROM projects WHERE id IN (${placeholders(removedProjectIds)})`,
      )
      .run(...removedProjectIds);
    result.removedProjectIds = removedProjectIds;
  }

  return result;
}

/**
 * Replaces one chat's transcript. False when the chat does not exist.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} chatId
 * @param {unknown[]} messages
 * @param {string} now
 */
export function saveChatMessages(database, chatId, messages, now) {
  if (
    typeof chatId !== "string" ||
    !chatId.trim() ||
    !Array.isArray(messages)
  ) {
    return false;
  }
  if (
    !database.prepare("SELECT 1 FROM chats WHERE id = ? LIMIT 1").get(chatId)
  ) {
    return false;
  }

  const upsertMessage = database.prepare(
    `
      INSERT INTO chat_messages (
        id, chat_id, role, sort_order, payload, metadata, created_at
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
    if (!isRecord(message)) return;
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

  // Remove only this chat's stale rows.
  if (persistedMessageIds.length === 0) {
    database.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
  } else {
    database
      .prepare(
        `DELETE FROM chat_messages
         WHERE chat_id = ? AND id NOT IN (${placeholders(persistedMessageIds)})`,
      )
      .run(chatId, ...persistedMessageIds);
  }
  return true;
}

/**
 * One chat's transcript, in order.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} chatId
 */
export function loadChatMessages(database, chatId) {
  if (typeof chatId !== "string" || !chatId.trim()) return [];
  return database
    .prepare(
      "SELECT payload FROM chat_messages WHERE chat_id = ? ORDER BY sort_order, id",
    )
    .all(chatId)
    .flatMap((row) => {
      const payload = parseJson(row.payload, null);
      return isRecord(payload) ? [payload] : [];
    });
}
