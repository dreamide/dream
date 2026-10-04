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

// ── Transcript search ─────────────────────────────────────────────────

const SEARCH_SNIPPET_BEFORE = 48;
const SEARCH_SNIPPET_AFTER = 160;
/** Rows read for one search; the newest chats come first. */
const SEARCH_ROW_LIMIT = 2000;

/** `value` as it appears inside a JSON string, for a LIKE pattern. */
const likePatternFor = (value) =>
  `%${JSON.stringify(value)
    .slice(1, -1)
    .replace(/[\\%_]/g, "\\$&")}%`;

/** The prose of a message: its text parts, not reasoning or tool traffic. */
const messageTexts = (message) =>
  (Array.isArray(message.parts) ? message.parts : []).flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : [],
  );

const collapse = (text) => text.replace(/\s+/g, " ");

/** The match with some of the text around it, or null without a match. */
const snippetOf = (text, needle) => {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - SEARCH_SNIPPET_BEFORE);
  const matchEnd = index + needle.length;
  const end = Math.min(text.length, matchEnd + SEARCH_SNIPPET_AFTER);
  return {
    after: `${collapse(text.slice(matchEnd, end)).trimEnd()}${end < text.length ? "…" : ""}`,
    before: `${start > 0 ? "…" : ""}${collapse(text.slice(start, index)).trimStart()}`,
    match: text.slice(index, matchEnd),
  };
};

/**
 * The chats whose transcript says `query` (case-insensitively, in a user or
 * assistant message's text), most recently updated first. Each carries its
 * latest matching message as a snippet and how many of its messages match.
 * `truncated` says the search stopped early, so older matches may be missing.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} query
 * @param {{ limit?: number }} [options] `limit`: the most chats to return
 * @returns {{
 *   results: {
 *     chatId: string,
 *     matchCount: number,
 *     messageId: string | null,
 *     role: string,
 *     snippet: { before: string, match: string, after: string },
 *   }[],
 *   truncated: boolean,
 * }}
 */
export function searchChatMessages(database, query, { limit = 50 } = {}) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!needle) return { results: [], truncated: false };

  // The payload is JSON, so LIKE only narrows the rows (it also matches tool
  // output and keys); the text parts decide.
  const rows = database
    .prepare(
      `
        SELECT chat_messages.chat_id AS chat_id, chat_messages.payload AS payload
        FROM chat_messages
        INNER JOIN chats ON chats.id = chat_messages.chat_id
        WHERE chat_messages.payload LIKE ? ESCAPE '\\'
        ORDER BY chats.updated_at DESC, chats.id, chat_messages.sort_order DESC
        LIMIT ?
      `,
    )
    .all(likePatternFor(needle), SEARCH_ROW_LIMIT + 1);

  let truncated = rows.length > SEARCH_ROW_LIMIT;
  /** @type {Map<string, any>} */
  const byChat = new Map();
  for (const row of rows.slice(0, SEARCH_ROW_LIMIT)) {
    const message = parseJson(row.payload, null);
    if (!isRecord(message)) continue;
    let snippet = null;
    for (const text of messageTexts(message)) {
      snippet = snippetOf(text, needle);
      if (snippet) break;
    }
    if (!snippet) continue;

    const found = byChat.get(row.chat_id);
    if (found) {
      found.matchCount += 1;
      continue;
    }
    if (byChat.size >= limit) {
      truncated = true;
      break;
    }
    byChat.set(row.chat_id, {
      chatId: row.chat_id,
      matchCount: 1,
      messageId: typeof message.id === "string" ? message.id : null,
      role: typeof message.role === "string" ? message.role : "",
      snippet,
    });
  }
  return { results: [...byChat.values()], truncated };
}
