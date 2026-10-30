// The host catalog as a service: what clients read and change over the
// catalog routes, and what tells every client about each change.
//
// Reads go through the state reader (a pool of reader threads), writes
// through the state writer (the save queue and its worker thread), in
// order, so a chat row always lands before its transcript. The host's
// thread runs neither: a search or a large transcript never blocks it.
// Each applied change is published on the host socket's catalog channel,
// stamped with the `origin` client that made it so that client can skip
// its own echo.

import { getPersistedStateDatabase } from "../persisted-state.js";
import {
  chatFromRow,
  chatToRow,
  projectFromRow,
  projectToCatalogRow,
} from "../shared/persisted-state-codec.js";
import { catalogReads } from "./catalog-store.js";

/**
 * Reads on this thread's own connection: for a catalog given no reader
 * (route tests), never for a host serving clients.
 */
const inThreadReader = {
  read: async (type, payload = {}) =>
    catalogReads[type](getPersistedStateDatabase(), payload),
};

/** A project as the catalog shares it: no workspace fields. */
const catalogProject = (project) =>
  projectFromRow(projectToCatalogRow(project), {
    lastUsedAt: null,
    ui: undefined,
  });

/** A chat as the catalog shares it (what a stored row reads back as). */
const catalogChat = (chat) => {
  const row = chatToRow(chat);
  return chatFromRow({
    created_at: row.createdAt,
    deleted_at: row.deletedAt,
    id: row.id,
    metadata: row.metadata,
    project_id: row.projectId,
    title: row.title,
    updated_at: row.updatedAt,
  });
};

/**
 * @param {{
 *   events: { publish: (event: object) => void },
 *   getWriter: () => {
 *     applyCatalogChanges: (changes: object) => Promise<any>,
 *     mutateRunQueue: (operation: { type: string, chatId?: string }) => Promise<any>,
 *     saveChatMessages: (payload: { chatId: string, fromIndex?: number, messages: unknown[] }) => Promise<unknown>,
 *     saveProviderSession: (payload: object) => Promise<unknown>,
 *   },
 *   getReader?: () => { read: (type: string, payload?: object) => Promise<any> },
 *   getRunningChatIds?: () => string[],
 *   getAwaitingApprovalChatIds?: () => string[],
 * }} options
 *   `getReader`: where reads run (state-read-pool.js); this thread when
 *   omitted. `getRunningChatIds`: the chats with a turn running now,
 *   listed with the catalog so a client knows which to resume.
 *   `getAwaitingApprovalChatIds`: the chats whose turn waits on a tool
 *   approval now, listed so a client shows them before any event.
 */
export function createHostCatalog({
  events,
  getWriter,
  getReader = () => inThreadReader,
  getRunningChatIds = () => [],
  getAwaitingApprovalChatIds = () => [],
}) {
  const read = (type, payload) => getReader().read(type, payload);

  return {
    runQueue: (chatId) => read("run-queue", { chatId }),
    delegatedTasks: (chatId) => read("delegated-tasks", { chatId }),
    transcriptPage: (request) => read("transcript-page", request),
    providerSession: (chatId, provider) =>
      read("provider-session", { chatId, provider }),
    saveProviderSession: (payload) => getWriter().saveProviderSession(payload),
    async mutateRunQueue(operation) {
      const result = await getWriter().mutateRunQueue(operation);
      if (operation.chatId && result)
        events.publish({
          kind: "queue",
          chatId: operation.chatId,
          origin: "host",
        });
      if (operation.type === "delegate" && result && !result.duplicate) {
        const chat = await read("chat", { chatId: result.childChatId });
        events.publish({
          kind: "changes",
          chats: [chat],
          projects: [],
          removedChatIds: [],
          removedProjectIds: [],
          origin: "host",
        });
      }
      return result;
    },
    /**
     * Every project and chat, raw, and the chats with a turn running. Read
     * after the writes queued before it (a reloaded window's last changes).
     */
    list: async () => {
      await getWriter().settled?.();
      return {
        ...(await read("catalog")),
        runningChatIds: getRunningChatIds(),
        awaitingApprovalChatIds: getAwaitingApprovalChatIds(),
      };
    },

    /**
     * One chat, raw, or null.
     * @param {string} chatId
     */
    getChat: (chatId) => read("chat", { chatId }),

    /**
     * The directory of a chat's project (or a project's), or null.
     * @param {{ chatId?: string | null, projectId?: string | null }} ids
     */
    resolveProjectPath: (ids) => read("project-path", ids),

    /**
     * Applies a change set and tells every client what was applied.
     * @param {import("./catalog-store.js").CatalogChanges} changes
     * @param {{ origin?: string | null }} [options]
     */
    async applyChanges(changes, { origin = null } = {}) {
      const result = await getWriter().applyCatalogChanges(changes);
      const projectIds = new Set(result.projectIds);
      const chatIds = new Set(result.chatIds);
      const projects = (Array.isArray(changes.projects) ? changes.projects : [])
        .filter((project) => projectIds.has(project?.id))
        .map(catalogProject);
      const chats = (Array.isArray(changes.chats) ? changes.chats : [])
        .filter((chat) => chatIds.has(chat?.id))
        .map(catalogChat);
      if (
        projects.length > 0 ||
        chats.length > 0 ||
        result.removedProjectIds.length > 0 ||
        result.removedChatIds.length > 0
      ) {
        events.publish({
          chats,
          kind: "changes",
          origin,
          projects,
          removedChatIds: result.removedChatIds,
          removedProjectIds: result.removedProjectIds,
        });
      }
      return result;
    },

    /**
     * A chat's transcript as the JSON text of its message array, to send
     * as is: it is never parsed or re-serialized on this thread.
     * @param {string} chatId
     * @returns {Promise<string>}
     */
    getTranscriptJson: (chatId) => read("transcript-json", { chatId }),

    /**
     * The chats whose transcript says `query`, newest first.
     * @param {string} query
     * @param {{ limit?: number }} [options]
     */
    search: (query, { limit } = {}) => read("search", { limit, query }),

    /**
     * Replaces a chat's transcript, from `fromIndex` on when given (the
     * messages before it stay as they are); false when the chat does not
     * exist.
     * @param {string} chatId
     * @param {unknown[]} messages
     * @param {{ fromIndex?: number, mergeOnly?: boolean, origin?: string | null }} [options]
     */
    async saveTranscript(
      chatId,
      messages,
      { fromIndex = 0, mergeOnly = false, origin = null } = {},
    ) {
      const saved =
        (await getWriter().saveChatMessages({
          chatId,
          fromIndex,
          mergeOnly,
          messages,
        })) === true;
      if (saved) {
        events.publish({
          chatId,
          kind: "transcript",
          ...(mergeOnly ? {} : { messageCount: fromIndex + messages.length }),
          origin,
        });
      }
      return saved;
    },
  };
}
