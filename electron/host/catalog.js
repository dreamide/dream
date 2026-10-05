// The host catalog as a service: what clients read and change over the
// catalog routes, and what tells every client about each change.
//
// Reads go straight to the database. Writes go through the state writer
// (the save queue and its worker thread), in order, so a chat row always
// lands before its transcript and the host's thread never blocks on a large
// transcript. Each applied change is published on the host socket's catalog
// channel, stamped with the `origin` client that made it so that client can
// skip its own echo.

import {
  loadPersistedCatalog,
  loadPersistedChat,
  loadPersistedChatMessages,
  searchPersistedChatMessages,
} from "../persisted-state.js";
import {
  chatFromRow,
  chatToRow,
  projectFromRow,
  projectToCatalogRow,
} from "../shared/persisted-state-codec.js";

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
 *     saveChatMessages: (payload: { chatId: string, fromIndex?: number, messages: unknown[] }) => Promise<unknown>,
 *   },
 *   getRunningChatIds?: () => string[],
 * }} options
 *   `getRunningChatIds`: the chats with a turn running now, listed with
 *   the catalog so a client knows which to resume.
 */
export function createHostCatalog({
  events,
  getWriter,
  getRunningChatIds = () => [],
}) {
  return {
    /** Every project and chat, raw, and the chats with a turn running. */
    list: () => ({
      ...loadPersistedCatalog(),
      runningChatIds: getRunningChatIds(),
    }),

    /** @param {string} chatId */
    getChat: (chatId) => loadPersistedChat(chatId),

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

    /** @param {string} chatId */
    getTranscript: (chatId) => loadPersistedChatMessages(chatId),

    /**
     * The chats whose transcript says `query`, newest first.
     * @param {string} query
     * @param {{ limit?: number }} [options]
     */
    search: (query, options) => searchPersistedChatMessages(query, options),

    /**
     * Replaces a chat's transcript, from `fromIndex` on when given (the
     * messages before it stay as they are); false when the chat does not
     * exist.
     * @param {string} chatId
     * @param {unknown[]} messages
     * @param {{ fromIndex?: number, origin?: string | null }} [options]
     */
    async saveTranscript(
      chatId,
      messages,
      { fromIndex = 0, origin = null } = {},
    ) {
      const saved =
        (await getWriter().saveChatMessages({
          chatId,
          fromIndex,
          messages,
        })) === true;
      if (saved) {
        events.publish({
          chatId,
          kind: "transcript",
          messageCount: fromIndex + messages.length,
          origin,
        });
      }
      return saved;
    },
  };
}
