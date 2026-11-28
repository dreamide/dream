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
import { readDeviceSessions } from "./auth/session-store.js";
import { readDelegatedTasks } from "./delegation-store.js";
import { readProviderSession } from "./provider-session-store.js";
import { readRunQueue } from "./run-store.js";
import {
  readTranscriptPage,
  readTranscriptPageJson,
} from "./transcript-page.js";

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

// Read the Host-owned parent for snapshots and events, including edits by older clients.
const parentChatColumn =
  "(SELECT parent_chat_id FROM delegated_tasks WHERE child_chat_id = chats.id) AS parent_chat_id";
const catalogChat = (row) =>
  chatFromRow({ ...row, metadata: parseJson(row.metadata, {}) });

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
        SELECT chats.*, COUNT(chat_messages.chat_id) AS message_count, ${parentChatColumn}
        FROM chats
        LEFT JOIN chat_messages ON chat_messages.chat_id = chats.id
        GROUP BY chats.id
        ORDER BY chats.created_at, chats.id
      `,
    )
    .all()
    .map(catalogChat);
  return { chats, projects };
}

/**
 * One chat, raw, or null.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} chatId
 */
export function loadChat(database, chatId) {
  const row = database
    .prepare(`SELECT *, ${parentChatColumn} FROM chats WHERE id = ? LIMIT 1`)
    .get(chatId);
  return row ? catalogChat(row) : null;
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
 *   chats: ReturnType<typeof chatFromRow>[],
 *   removedProjectIds: string[],
 *   removedChatIds: string[],
 *   conflicts: { id: string, existingId: string, path: string }[],
 * }} what was applied, and the projects refused for a taken path
 */
export function applyCatalogChanges(database, changes, now) {
  const result = {
    chatIds: [],
    chats: [],
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
      RETURNING *, ${parentChatColumn}
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
    const stored = upsertChat.get(
      row.id,
      row.projectId,
      row.title,
      toJson(row.metadata),
      createdAt,
      row.updatedAt ?? createdAt,
      row.deletedAt,
    );
    result.chats.push(catalogChat(stored));
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

/** What separates a message's text parts in `chat_message_text`. */
const TEXT_PART_SEPARATOR = "\u001f";

/**
 * The prose of a message: its text parts, not reasoning or tool traffic.
 * What transcript search reads (migration 0003 derives the same from
 * stored payloads).
 */
const messageTexts = (message) =>
  (Array.isArray(message.parts) ? message.parts : []).flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : [],
  );

/**
 * Replaces one chat's transcript from `fromIndex` on (all of it by default):
 * `messages[0]` becomes the message at `fromIndex`, and whatever the chat
 * held past the last of them goes. Messages before `fromIndex` are not
 * read or touched. Only rows that differ from what is stored are written,
 * so saving a transcript again costs what changed in it. Stored payloads
 * are never read back into JavaScript: a payload of another size has
 * changed, and one of the same size is compared inside SQLite, so a
 * message that grows to megabytes over a turn is not copied out again at
 * every step. Each written message's search text (`chat_message_text`)
 * is written beside it. False when the chat does not exist.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} chatId
 * @param {unknown[]} messages
 * @param {string} now
 * @param {{ fromIndex?: number }} [options]
 */
export function saveChatMessages(
  database,
  chatId,
  messages,
  now,
  { fromIndex = 0 } = {},
) {
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

  const start = Number.isInteger(fromIndex) && fromIndex > 0 ? fromIndex : 0;
  // octet_length is read from the row's header: no payload is loaded.
  /** @type {Map<string, number>} stored row id → payload bytes, from `start` on */
  const stored = new Map(
    database
      .prepare(
        "SELECT id, octet_length(payload) AS bytes FROM chat_messages WHERE chat_id = ? AND sort_order >= ?",
      )
      .all(chatId, start)
      .map((row) => [row.id, row.bytes]),
  );
  const storedPayloadIs = database.prepare(
    "SELECT payload = ? AS same FROM chat_messages WHERE id = ?",
  );
  const saveText = database.prepare(
    `
      INSERT INTO chat_message_text (message_row, message_id, text)
      VALUES (?, ?, ?)
      ON CONFLICT(message_row) DO UPDATE SET
        message_id = excluded.message_id,
        text = excluded.text
    `,
  );
  const removeText = database.prepare(
    "DELETE FROM chat_message_text WHERE message_row = ?",
  );

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
  messages.forEach((message, offset) => {
    if (!isRecord(message)) return;
    const index = start + offset;
    const messageId =
      typeof message.id === "string" && message.id.trim()
        ? message.id
        : `message-${index}`;
    // The row id names the chat and the position, and the payload carries
    // the role, so an equal payload under the same id is the same row.
    const persistedMessageId = `${chatId}:${index}:${messageId}`;
    const payload = toJson(message);
    const storedBytes = stored.get(persistedMessageId);
    stored.delete(persistedMessageId);
    if (
      storedBytes === Buffer.byteLength(payload) &&
      storedPayloadIs.get(payload, persistedMessageId)?.same === 1
    ) {
      return;
    }
    upsertMessage.run(
      persistedMessageId,
      chatId,
      typeof message.role === "string" ? message.role : "",
      index,
      payload,
      toJson({}),
      now,
    );
    const texts = messageTexts(message);
    if (texts.length > 0) {
      saveText.run(
        persistedMessageId,
        typeof message.id === "string" ? message.id : null,
        texts.join(TEXT_PART_SEPARATOR),
      );
    } else if (storedBytes !== undefined) {
      removeText.run(persistedMessageId);
    }
  });

  // What is left was stored from `start` on and is no longer in the
  // transcript. Its search text goes with it (a trigger).
  if (stored.size > 0) {
    const removeMessage = database.prepare(
      "DELETE FROM chat_messages WHERE id = ?",
    );
    for (const staleId of stored.keys()) removeMessage.run(staleId);
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

/**
 * Every chat id in the catalog, without touching chat_messages or row JSON.
 * @param {import("node:sqlite").DatabaseSync} database
 * @returns {string[]}
 */
export function loadChatIds(database) {
  return database
    .prepare("SELECT id FROM chats")
    .all()
    .map((row) => row.id);
}

/**
 * Every project path in the catalog, without touching chats or metadata JSON.
 * @param {import("node:sqlite").DatabaseSync} database
 * @returns {string[]}
 */
export function loadProjectPaths(database) {
  return database
    .prepare("SELECT path FROM projects")
    .all()
    .map((row) => row.path);
}

/**
 * One chat's transcript, in order, as the JSON text of an array: the
 * stored payloads joined, never re-serialized, so a reader on another
 * thread can hand it to a response as is. A payload that is not a JSON
 * object is left out, as `loadChatMessages` leaves it out.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} chatId
 */
export function loadChatMessagesJson(database, chatId) {
  if (typeof chatId !== "string" || !chatId.trim()) return "[]";
  // Rows are constrained by CHECK(json_valid(payload)), so a leading "{"
  // identifies JSON objects without parsing and discarding every payload.
  const payloads = database
    .prepare(
      "SELECT payload FROM chat_messages WHERE chat_id = ? ORDER BY sort_order, id",
    )
    .all(chatId)
    .flatMap((row) =>
      typeof row.payload === "string" && row.payload.trimStart().startsWith("{")
        ? [row.payload]
        : [],
    );
  return `[${payloads.join(",")}]`;
}

/**
 * The directory of a chat's project, or of a project, or null: the chat
 * wins when both are given and it names one.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{ chatId?: unknown, projectId?: unknown }} ids
 */
export function resolveProjectPath(database, { chatId, projectId } = {}) {
  const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
  const normalizedProjectId =
    typeof projectId === "string" ? projectId.trim() : "";
  const nonEmptyPath = (row) =>
    typeof row?.path === "string" && row.path.trim() ? row.path : null;

  if (normalizedChatId) {
    const path = nonEmptyPath(
      database
        .prepare(
          `
            SELECT projects.path AS path
            FROM chats
            INNER JOIN projects ON projects.id = chats.project_id
            WHERE chats.id = ?
            LIMIT 1
          `,
        )
        .get(normalizedChatId),
    );
    if (path) return path;
  }

  if (normalizedProjectId) {
    return nonEmptyPath(
      database
        .prepare("SELECT path FROM projects WHERE id = ? LIMIT 1")
        .get(normalizedProjectId),
    );
  }

  return null;
}

// ── Transcript search ─────────────────────────────────────────────────

const SEARCH_SNIPPET_BEFORE = 48;
const SEARCH_SNIPPET_AFTER = 160;
/** Rows read for one search; the newest chats come first. */
const SEARCH_ROW_LIMIT = 2000;

/** A LIKE pattern matching `value` anywhere, its wildcards taken literally. */
const likePatternFor = (value) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

/** An FTS5 phrase matching `value` literally inside a trigram index. */
const ftsTrigramQueryFor = (value) => `"${value.replace(/"/g, '""')}"`;

/** Trigram indexes match substrings of at least 3 Unicode code points. */
const canUseFtsTrigram = (value) =>
  !value.includes("\0") && Array.from(value).length >= 3;

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

  // Only the messages' prose is read (chat_message_text), never their
  // payloads. Queries of 3+ characters narrow rows via the trigram FTS5
  // index; shorter queries fall back to LIKE because trigrams require 3 code
  // points. Either way, each text part decides the final snippet so matches
  // never span across parts.
  const rows = canUseFtsTrigram(needle)
    ? database
        .prepare(
          `
            SELECT
              chat_messages.chat_id AS chat_id,
              chat_messages.role AS role,
              chat_message_text.message_id AS message_id,
              chat_message_text.text AS text
            FROM chat_message_text_fts
            INNER JOIN chat_message_text
              ON chat_message_text.rowid = chat_message_text_fts.rowid
            INNER JOIN chat_messages
              ON chat_messages.id = chat_message_text.message_row
            INNER JOIN chats ON chats.id = chat_messages.chat_id
            WHERE chat_message_text_fts MATCH ?
            ORDER BY chats.updated_at DESC, chats.id, chat_messages.sort_order DESC
            LIMIT ?
          `,
        )
        .all(ftsTrigramQueryFor(needle), SEARCH_ROW_LIMIT + 1)
    : database
        .prepare(
          `
            SELECT
              chat_messages.chat_id AS chat_id,
              chat_messages.role AS role,
              chat_message_text.message_id AS message_id,
              chat_message_text.text AS text
            FROM chat_message_text
            INNER JOIN chat_messages
              ON chat_messages.id = chat_message_text.message_row
            INNER JOIN chats ON chats.id = chat_messages.chat_id
            WHERE chat_message_text.text LIKE ? ESCAPE '\\'
            ORDER BY chats.updated_at DESC, chats.id, chat_messages.sort_order DESC
            LIMIT ?
          `,
        )
        .all(likePatternFor(needle), SEARCH_ROW_LIMIT + 1);

  let truncated = rows.length > SEARCH_ROW_LIMIT;
  /** @type {Map<string, any>} */
  const byChat = new Map();
  for (const row of rows.slice(0, SEARCH_ROW_LIMIT)) {
    let snippet = null;
    for (const text of row.text.split(TEXT_PART_SEPARATOR)) {
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
      messageId: typeof row.message_id === "string" ? row.message_id : null,
      role: typeof row.role === "string" ? row.role : "",
      snippet,
    });
  }
  return { results: [...byChat.values()], truncated };
}

/**
 * The catalog's reads by name, each on a given connection: what a reader
 * thread answers (persisted-state-read-worker.js) and, in route tests, what
 * the catalog runs in its own thread. Each returns plain data a worker can
 * post back.
 * @type {Record<string, (database: import("node:sqlite").DatabaseSync, payload: any) => unknown>}
 */
export const catalogReads = {
  "chat-ids": (database) => loadChatIds(database),
  "device-sessions": (database) => readDeviceSessions(database),
  "project-paths": (database) => loadProjectPaths(database),
  "transcript-page": readTranscriptPage,
  "transcript-page-json": readTranscriptPageJson,
  "delegated-tasks": (database, { chatId }) =>
    readDelegatedTasks(database, chatId),
  "provider-session": readProviderSession,
  "run-queue": (database, { chatId }) => readRunQueue(database, chatId),
  catalog: (database) => loadCatalog(database),
  chat: (database, { chatId }) => loadChat(database, chatId),
  "project-path": (database, ids) => resolveProjectPath(database, ids),
  search: (database, { limit, query }) =>
    searchChatMessages(database, query, { limit }),
  transcript: (database, { chatId }) => loadChatMessages(database, chatId),
  "transcript-json": (database, { chatId }) =>
    loadChatMessagesJson(database, chatId),
};
