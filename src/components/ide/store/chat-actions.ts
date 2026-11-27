// Chats within a project. The document operations live in
// workspace-document.ts; these wrappers add the runtime side (streaming
// guards, seeing a chat's "finished while away" mark, transcript
// persistence, checkpoint cleanup).
import type { UIMessage } from "ai";
import type { ChatConfig, ChatSortOrder } from "@/types/ide";
import { isChatRunning } from "../chat-activity";
import {
  createBranchedChatConfig,
  getMessagesThroughBranchPoint,
} from "../chat-branching";
import { mergeChatMessageHistories } from "../chat-message-history";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { requestChatCheckpointCleanup } from "./checkpoint-cleanup";
import { areMessagesEqual, shouldTouchChatUpdatedAt } from "./helpers";
import type {
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import { commitWorkspaceRemoval } from "./project-runtime-state";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";
import * as workspace from "./workspace-document";

/** The chat actions in the store (`IdeState`). */
export interface ChatActions {
  addChat: (
    projectId: string,
    title?: string,
    options?: { forceNew?: boolean },
  ) => string | null;
  addChatBeside: (projectId: string) => string | null;
  branchChatInWorkspace: (options: {
    chatId: string;
    messageId: string;
  }) => string;
  branchChatInNewWorktree: (options: {
    baseRef?: string | null;
    branchName: string;
    chatId: string;
    messageId: string;
  }) => Promise<{ chatId: string; projectId: string }>;
  toggleProjectMultiChatMode: (projectId: string) => void;
  /** Closes a side-by-side chat column; the chat stays. */
  closeChatColumn: (projectId: string, chatId: string) => void;
  reorderChatColumns: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  setChatColumnWidths: (
    projectId: string,
    widths: Record<string, number>,
  ) => void;
  setActiveChatId: (projectId: string, chatId: string | null) => void;
  updateChat: (
    chatId: string,
    updater: (chat: ChatConfig) => ChatConfig,
  ) => void;
  archiveInactiveChats: () => number;
  toggleChatPinned: (chatId: string) => void;
  deleteChat: (chatId: string) => void;
  permanentlyDeleteChats: (chatIds: string[]) => void;
  restoreChats: (chatIds: string[]) => void;
  setMessagesForChat: (chatId: string, messages: UIMessage[]) => void;
  setChatSort: (sortOrder: ChatSortOrder) => void;
}

export const createChatActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  {
    api,
    persist,
    persistTranscript,
    terminals = createTerminalSessionOwner(set, get),
  }: StoreActionDependencies & {
    /** Saves every slice now (the save scheduler in ide-store.ts). */
    persist: () => void;
    /** Saves a chat's transcript (store/transcript-cache.ts). */
    persistTranscript?: (chatId: string) => Promise<void>;
    /** The Terminal session owner, which stops a removed Project's terminals. */
    terminals?: Pick<TerminalSessionOwner, "dropProject">;
  },
): ChatActions => ({
  addChat: (
    projectId: string,
    title?: string,
    options?: { forceNew?: boolean },
  ) => {
    let chatId: string | null = null;
    set((state) => {
      const result = workspace.addChat(state, state.settings, projectId, {
        forceNew: options?.forceNew,
        title,
      });
      chatId = result.chatId;
      return result.doc;
    });
    return chatId;
  },

  addChatBeside: (projectId: string) => {
    let chatId: string | null = null;
    set((state) => {
      const result = workspace.addChatBeside(state, state.settings, projectId);
      chatId = result.chatId;
      return result.doc;
    });
    return chatId;
  },

  branchChatInWorkspace: ({ chatId, messageId }) => {
    if (get().transcriptPageByChatId[chatId]?.before)
      throw new Error("Load the complete transcript before branching.");
    const state = get();
    const sourceChat = state.chats.find((chat) => chat.id === chatId);
    if (!sourceChat || sourceChat.deletedAt !== null) {
      throw new Error("Unable to find the source chat.");
    }
    if (isChatRunning(state, chatId)) {
      throw new Error("Unable to branch a chat while it is streaming.");
    }

    const project = state.projects.find(
      (item) => item.id === sourceChat.projectId,
    );
    if (!project) {
      throw new Error("Unable to find the source project.");
    }

    const messages = getMessagesThroughBranchPoint(
      state.messagesByChatId[chatId] ?? [],
      messageId,
    );
    const branchedChat = createBranchedChatConfig(
      sourceChat,
      project,
      messageId,
    );
    branchedChat.messageCount = messages.length;

    set((current) =>
      workspace.branchChat(
        current,
        current.settings,
        { chat: branchedChat, messages },
        sourceChat.id,
      ),
    );

    void persistTranscript?.(branchedChat.id);

    return branchedChat.id;
  },

  branchChatInNewWorktree: async ({
    baseRef,
    branchName,
    chatId,
    messageId,
  }) => {
    if (get().transcriptPageByChatId[chatId]?.before)
      await get().loadMessagesForChat(chatId);
    const state = get();
    const sourceChat = state.chats.find((chat) => chat.id === chatId);
    if (!sourceChat || sourceChat.deletedAt !== null) {
      throw new Error("Unable to find the source chat.");
    }
    if (isChatRunning(state, chatId)) {
      throw new Error("Unable to branch a chat while it is streaming.");
    }
    if (
      !state.projects.some((project) => project.id === sourceChat.projectId)
    ) {
      throw new Error("Unable to find the source project.");
    }

    const messages = getMessagesThroughBranchPoint(
      state.messagesByChatId[chatId] ?? [],
      messageId,
    );
    const result = await get().createWorktreeProject(sourceChat.projectId, {
      baseRef,
      branchName,
      initialChatSeed: {
        messageId,
        messages,
        sourceChat: structuredClone(sourceChat),
      },
    });

    if (!result?.chatId) {
      throw new Error("Unable to create the branched chat.");
    }

    return { chatId: result.chatId, projectId: result.projectId };
  },

  toggleProjectMultiChatMode: (projectId: string) => {
    set((state) => workspace.toggleMultiChat(state, state.settings, projectId));
  },

  closeChatColumn: (projectId, chatId) => {
    set((state) =>
      workspace.closeChatColumn(state, state.settings, projectId, chatId),
    );
  },

  reorderChatColumns: (projectId, fromIndex, toIndex) => {
    set((state) =>
      workspace.reorderChatColumns(
        state,
        state.settings,
        projectId,
        fromIndex,
        toIndex,
      ),
    );
  },

  setChatColumnWidths: (projectId, widths) => {
    set((state) =>
      workspace.setChatColumnWidths(state, state.settings, projectId, widths),
    );
  },

  setActiveChatId: (projectId: string, chatId: string | null) => {
    set((state) =>
      workspace.focusChat(state, state.settings, projectId, chatId),
    );
    const activeChatId = get().projects.find(
      (project) => project.id === projectId,
    )?.ui.activeChatId;
    if (activeChatId) chatTurnOutcomes.seen([activeChatId]);
  },

  updateChat: (chatId: string, updater: (chat: ChatConfig) => ChatConfig) => {
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? updater(chat) : chat,
      ),
    }));
  },

  toggleChatPinned: (chatId: string) => {
    get().updateChat(chatId, (chat) => ({ ...chat, pinned: !chat.pinned }));
    persist();
  },

  archiveInactiveChats: () => {
    const state = get();
    const days = state.settings.archiveChatsAfterDays;
    if (!Number.isInteger(days) || days < 1) {
      return 0;
    }

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const chatIds = state.chats
      .filter((chat) => {
        if (
          chat.deletedAt !== null ||
          chat.pinned ||
          isChatRunning(state, chat.id) ||
          state.titleGeneratingChatIds[chat.id]
        ) {
          return false;
        }

        const lastActivityAt = Date.parse(chat.updatedAt || chat.createdAt);
        return Number.isFinite(lastActivityAt) && lastActivityAt <= cutoff;
      })
      .map((chat) => chat.id);

    for (const chatId of chatIds) {
      get().deleteChat(chatId);
    }

    return chatIds.length;
  },

  deleteChat: (chatId: string) => {
    const state = get();
    // The Chat turn outcome forgets its mark (chat-turn-outcome.ts).
    const doc = workspace.deleteChat(state, state.settings, chatId);
    void commitWorkspaceRemoval(
      set,
      terminals,
      workspace.removalBetween(state, doc),
    );
  },

  permanentlyDeleteChats: (chatIds: string[]) => {
    const current = get();
    const deletedChats = current.chats.filter((chat) =>
      chatIds.includes(chat.id),
    );
    if (deletedChats.length === 0) {
      return;
    }

    requestChatCheckpointCleanup(
      deletedChats,
      [...current.projects, ...current.closedProjects],
      api,
    );

    const deletedChatIds = deletedChats.map((chat) => chat.id);
    const doc = workspace.removeChats(
      current,
      current.settings,
      deletedChatIds,
    );

    // A standalone project goes with its last chat; nothing could show it.
    const emptied = workspace.standaloneProjectsWithoutChats(doc);
    const after = emptied.length
      ? workspace.removeProjects(doc, current.settings, emptied).doc
      : doc;
    void commitWorkspaceRemoval(
      set,
      terminals,
      workspace.removalBetween(current, after),
    );
    if (emptied.length > 0) {
      persist();
    }
  },

  restoreChats: (chatIds: string[]) => {
    if (chatIds.length === 0) {
      return;
    }
    set((state) => workspace.restoreChats(state, state.settings, chatIds));
  },

  setMessagesForChat: (chatId: string, messages: UIMessage[]) => {
    set((state) => {
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat) {
        return state;
      }
      const previousMessages = state.messagesByChatId[chatId];
      const mergedMessages = mergeChatMessageHistories(
        previousMessages,
        messages,
      );

      const messagesChanged = !areMessagesEqual(
        previousMessages,
        mergedMessages,
      );

      if (!messagesChanged) {
        return state;
      }

      const touchUpdatedAt = shouldTouchChatUpdatedAt(
        previousMessages,
        mergedMessages,
      );

      // A draft stops being one once it has messages.
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };
      if (
        mergedMessages.length > 0 &&
        nextDraftChatIdByProject[chat.projectId] === chatId
      ) {
        nextDraftChatIdByProject[chat.projectId] = null;
      }

      return {
        draftChatIdByProject: nextDraftChatIdByProject,
        messagesByChatId: {
          ...state.messagesByChatId,
          [chatId]: mergedMessages,
        },
        chats: state.chats.map((item) =>
          item.id === chatId
            ? {
                ...item,
                messageCount: state.transcriptPageByChatId[chatId]?.before
                  ? Math.max(
                      state.transcriptPageByChatId[chatId].total,
                      mergedMessages.length,
                    )
                  : mergedMessages.length,
                ...(touchUpdatedAt
                  ? { updatedAt: new Date().toISOString() }
                  : {}),
              }
            : item,
        ),
      };
    });
  },

  setChatSort: (chatSort: ChatSortOrder) => set({ chatSort }),
});
