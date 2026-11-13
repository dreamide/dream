// Every write to a state database, by name: the write side of `catalogReads`
// (host/catalog-store.js). The save queue (state-save-queue.js) takes a
// write by its name, in order with every other, and its worker
// (persisted-state-worker.js) runs it on the one connection that writes.
//
// A write is one row here. Each runs in a transaction of its own
// (`runStateWrite`), so the store functions it calls never open one. A
// write the queue may merge with the same write queued just before it says
// how (`coalesce`); every other write is a delta and runs as sent.
import { writeDeviceSession } from "./host/auth/session-store.js";
import {
  applyCatalogChanges,
  loadChatMessages,
  saveChatMessages,
} from "./host/catalog-store.js";
import { saveProviderSession } from "./host/provider-session-store.js";
import { mutateRunQueue } from "./host/run-store.js";
import {
  getPersistedStateDatabase,
  saveWorkspaceChanges,
  writeConfigValue,
} from "./persisted-state.js";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const saveStartIndex = (payload) =>
  Number.isInteger(payload?.fromIndex) && payload.fromIndex > 0
    ? payload.fromIndex
    : 0;

/**
 * One transcript save standing for `queued` followed by `next`, or null when
 * they cannot be one (different chats, a merge-only save, or `next` starting
 * past where `queued` ends). A save replaces its chat's transcript from
 * `fromIndex` on, so the later one wins from its own start and the queued
 * one keeps what it said before that.
 */
export const mergeTranscriptSaves = (queued, next) => {
  if (queued?.mergeOnly || next?.mergeOnly) return null;
  if (
    queued?.chatId !== next?.chatId ||
    !Array.isArray(queued?.messages) ||
    !Array.isArray(next?.messages)
  ) {
    return null;
  }
  const queuedStart = saveStartIndex(queued);
  const nextStart = saveStartIndex(next);
  if (nextStart <= queuedStart) return next;
  const kept = nextStart - queuedStart;
  if (kept > queued.messages.length) return null;
  return {
    ...next,
    fromIndex: queuedStart,
    messages: [...queued.messages.slice(0, kept), ...next.messages],
  };
};

/**
 * A chat's transcript from `fromIndex` on (host/catalog-store.js). A
 * `mergeOnly` save instead replaces only the messages it names, in place,
 * and is refused when one of them is no longer there.
 */
const saveTranscript = (
  database,
  { chatId, fromIndex, messages, mergeOnly = false } = {},
) => {
  if (mergeOnly) {
    const updates = new Map(messages.map((message) => [message.id, message]));
    const history = loadChatMessages(database, chatId);
    const ids = new Set(history.map((message) => message.id));
    if (messages.some((message) => !ids.has(message.id)))
      throw new Error(
        "History changed before saving. Reload the conversation.",
      );
    messages = history.map((message) => updates.get(message.id) ?? message);
    fromIndex = 0;
  }
  return saveChatMessages(
    database,
    chatId,
    messages,
    new Date().toISOString(),
    {
      fromIndex,
    },
  );
};

/**
 * @typedef {object} StateWrite
 * @property {(database: import("node:sqlite").DatabaseSync, payload: any) => unknown} run
 *   Applies the write; returns plain data the worker can post back.
 * @property {(queued: any, next: any) => any} [coalesce]
 *   One payload standing for the same write queued just before and this
 *   one, or null when they must run apart.
 */

/** @type {Record<string, StateWrite>} */
export const stateWrites = {
  /** A host catalog change set: projects and chats, as rows. */
  "catalog-changes": {
    run: (database, changes) =>
      applyCatalogChanges(
        database,
        isRecord(changes) ? changes : {},
        new Date().toISOString(),
      ),
  },
  /** A chat's transcript; adjacent saves of one chat are merged. */
  transcript: { coalesce: mergeTranscriptSaves, run: saveTranscript },
  /** A Chat run queue operation (host/run-store.js). */
  "run-queue": { run: mutateRunQueue },
  /** A chat's provider session (host/provider-session-store.js). */
  "provider-session": { run: saveProviderSession },
  /** A paired device's session (host/auth/session-store.js). */
  "device-session": { run: writeDeviceSession },
  /** What changed in a client's workspace (persisted-state.js). */
  "workspace-changes": { run: saveWorkspaceChanges },
  /** One config value, `{ key, value }`: the theme, the install id. */
  config: { run: writeConfigValue },
};

/** The write named `name`, or null when there is none. */
export const findStateWrite = (name) =>
  typeof name === "string" && Object.hasOwn(stateWrites, name)
    ? stateWrites[name]
    : null;

/**
 * Runs one write on `database` in a transaction of its own: all of it, or
 * none of it when it throws.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} name
 * @param {unknown} payload
 */
export function runStateWrite(database, name, payload) {
  const write = findStateWrite(name);
  if (!write) throw new Error(`Unknown state write: ${String(name)}`);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = write.run(database, payload);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Runs one write on this thread's connection to the state database: for
 * tests and tools that have no save queue. The app writes through the queue.
 * @param {string} name
 * @param {unknown} payload
 * @param {{ databasePath?: string }} [options]
 */
export const writeState = (name, payload, options = {}) =>
  runStateWrite(getPersistedStateDatabase(options), name, payload);

/**
 * A `StateWriter` (state-save-queue.js) that writes on this thread, each
 * write at once: what tests hand a host catalog in place of the save queue.
 * @param {{ databasePath?: string }} [options]
 * @returns {import("./state-save-queue.js").StateWriter}
 */
export const createInThreadStateWriter = (options = {}) => ({
  write: async (name, payload) => writeState(name, payload, options),
  ready: async () => getPersistedStateDatabase(options),
  settled: async () => true,
});
