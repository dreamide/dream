// Chats within a project. The document operations live in
// workspace-document.ts; these wrappers add the runtime side (streaming
// guards, the "finished while away" marks, transcript persistence,
// checkpoint cleanup).
import type { UIMessage } from "ai";
import type { ChatConfig, ChatSortOrder } from "@/types/ide";
import {
  createBranchedChatConfig,
  getMessagesThroughBranchPoint,
} from "../chat-branching";
import { mergeChatMessageHistories } from "../chat-message-history";
import { requestChatCheckpointCleanup } from "./checkpoint-cleanup";
import { areMessagesEqual, shouldTouchChatUpdatedAt } from "./helpers";
import type {
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import * as workspace from "./workspace-document";

const withoutCompletedMarks = (
  completedChatIds: IdeState["completedChatIds"],
  chatIds: Iterable<string | null | undefined>,
) => {
  const next = { ...completedChatIds };
  for (const chatId of chatIds) {
    if (chatId) {
      delete next[chatId];
    }
  }
  return next;
};

export const createChatActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  { api }: StoreActionDependencies = {},
): Pick<
  IdeState,
  | "addChat"
  | "addChatBeside"
  | "branchChatInWorkspace"
  | "branchChatInNewWorktree"
  | "toggleProjectMultiChatMode"
  | "setActiveChatId"
  | "updateChat"
  | "archiveInactiveChats"
  | "toggleChatPinned"
  | "deleteChat"
  | "permanentlyDeleteChats"
  | "restoreChats"
  | "setMessagesForChat"
  | "setChatSort"
> => ({
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
    const state = get();
    const sourceChat = state.chats.find((chat) => chat.id === chatId);
    if (!sourceChat || sourceChat.deletedAt !== null) {
      throw new Error("Unable to find the source chat.");
    }
    if (state.streamingChatIds[chatId]) {
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

    void get().persistMessagesForChat?.(branchedChat.id);

    return branchedChat.id;
  },

  branchChatInNewWorktree: async ({
    baseRef,
    branchName,
    chatId,
    messageId,
  }) => {
    const state = get();
    const sourceChat = state.chats.find((chat) => chat.id === chatId);
    if (!sourceChat || sourceChat.deletedAt !== null) {
      throw new Error("Unable to find the source chat.");
    }
    if (state.streamingChatIds[chatId]) {
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

  setActiveChatId: (projectId: string, chatId: string | null) => {
    set((state) => {
      const doc = workspace.focusChat(state, state.settings, projectId, chatId);
      const activeChatId = doc.projects.find(
        (project) => project.id === projectId,
      )?.ui.activeChatId;
      return activeChatId && state.completedChatIds[activeChatId]
        ? {
            ...doc,
            completedChatIds: withoutCompletedMarks(state.completedChatIds, [
              activeChatId,
            ]),
          }
        : doc;
    });
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
    get().persist();
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
          state.streamingChatIds[chat.id] ||
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
    set((state) => {
      const doc = workspace.deleteChat(state, state.settings, chatId);
      return doc === state
        ? state
        : {
            ...doc,
            completedChatIds: withoutCompletedMarks(state.completedChatIds, [
              chatId,
            ]),
          };
    });
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
    set((state) => {
      const doc = workspace.removeChats(state, state.settings, deletedChatIds);
      return doc === state
        ? state
        : {
            ...doc,
            completedChatIds: withoutCompletedMarks(
              state.completedChatIds,
              deletedChatIds,
            ),
          };
    });
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
                messageCount: mergedMessages.length,
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
