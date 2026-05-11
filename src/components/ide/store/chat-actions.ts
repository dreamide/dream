import type { UIMessage } from "ai";
import { createChatConfig, getDefaultModelSelection } from "@/lib/ide-defaults";
import type { ChatConfig, ChatSortOrder } from "@/types/ide";
import { mergeChatMessageHistories } from "../chat-message-history";
import {
  ensureActiveChatForProject,
  sanitizeProjectUiForChats,
} from "../ide-state";
import {
  areMessagesEqual,
  shouldTouchChatUpdatedAt,
  updateProjectUiInList,
} from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { getPermissionModesForAutoAccept } from "./provider-model-state";

export const createChatActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "addChat"
  | "addChatBeside"
  | "toggleProjectMultiChatMode"
  | "setActiveChatId"
  | "updateChat"
  | "deleteChat"
  | "permanentlyDeleteChats"
  | "restoreChats"
  | "setMessagesForChat"
  | "setChatSort"
> => ({
  addChat: (projectId: string, title?: string) => {
    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }

      const existingDraftChatId = state.draftChatIdByProject[projectId] ?? null;
      if (
        existingDraftChatId &&
        state.chats.some((item) => item.id === existingDraftChatId)
      ) {
        return {
          activeProjectId: projectId,
          projects: updateProjectUiInList(
            state.projects,
            projectId,
            (item) => ({
              ...item.ui,
              activeChatId: existingDraftChatId,
              openChatIds: [existingDraftChatId],
              chatColumnWidths: {},
            }),
          ),
          ...getPermissionModesForAutoAccept(
            state.settings.autoAcceptPermissions,
          ),
        };
      }

      const defaultSelection = getDefaultModelSelection(state.settings);
      const nextChat = createChatConfig(project, {
        model: defaultSelection.model || project.model,
        provider: defaultSelection.model
          ? defaultSelection.provider
          : project.provider,
        title,
      });

      return {
        activeProjectId: projectId,
        projects: updateProjectUiInList(state.projects, projectId, (item) => ({
          ...item.ui,
          activeChatId: nextChat.id,
          openChatIds: [nextChat.id],
          chatColumnWidths: {},
        })),
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [projectId]: nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: [],
        },
        ...getPermissionModesForAutoAccept(
          state.settings.autoAcceptPermissions,
        ),
        chats: [...state.chats, nextChat],
      };
    });
  },

  addChatBeside: (projectId: string) => {
    let didAddChat = false;

    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }

      const defaultSelection = getDefaultModelSelection(state.settings);
      const nextChat = createChatConfig(project, {
        model: defaultSelection.model || project.model,
        provider: defaultSelection.model
          ? defaultSelection.provider
          : project.provider,
      });
      const nextChats = [...state.chats, nextChat];
      didAddChat = true;

      return {
        activeProjectId: projectId,
        projects: updateProjectUiInList(state.projects, projectId, (item) =>
          sanitizeProjectUiForChats(
            nextChats,
            projectId,
            {
              ...item.ui,
              multiChat: true,
              openChatIds: [...item.ui.openChatIds, nextChat.id],
            },
            nextChat.id,
          ),
        ),
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [projectId]: nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: [],
        },
        ...getPermissionModesForAutoAccept(
          state.settings.autoAcceptPermissions,
        ),
        chats: nextChats,
      };
    });

    if (didAddChat) {
      get().persist();
    }
  },

  toggleProjectMultiChatMode: (projectId: string) => {
    let didUpdate = false;

    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }

      const multiChat = !project.ui.multiChat;
      const preferredActiveChatId =
        project.ui.activeChatId ?? project.ui.openChatIds[0] ?? null;
      didUpdate = true;

      return {
        projects: updateProjectUiInList(state.projects, projectId, (item) =>
          sanitizeProjectUiForChats(
            state.chats,
            projectId,
            {
              ...item.ui,
              chatColumnWidths: multiChat ? item.ui.chatColumnWidths : {},
              multiChat,
            },
            preferredActiveChatId,
          ),
        ),
      };
    });

    if (didUpdate) {
      get().persist();
    }
  },

  setActiveChatId: (projectId: string, chatId: string | null) => {
    set((state) => {
      const nextActiveChatId =
        chatId &&
        state.chats.some(
          (chat) =>
            chat.projectId === projectId &&
            chat.id === chatId &&
            chat.deletedAt === null,
        )
          ? chatId
          : ensureActiveChatForProject(state.chats, projectId, chatId);

      return {
        projects: updateProjectUiInList(state.projects, projectId, (project) =>
          sanitizeProjectUiForChats(
            state.chats,
            projectId,
            project.ui,
            nextActiveChatId,
          ),
        ),
      };
    });
  },

  updateChat: (chatId: string, updater: (chat: ChatConfig) => ChatConfig) => {
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? updater(chat) : chat,
      ),
    }));
  },

  deleteChat: (chatId: string) => {
    set((state) => {
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat) {
        return state;
      }

      const deletedAt = new Date().toISOString();
      const nextChats = state.chats.map((item) =>
        item.id === chatId ? { ...item, deletedAt } : item,
      );
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };
      if (nextDraftChatIdByProject[chat.projectId] === chatId) {
        nextDraftChatIdByProject[chat.projectId] = null;
      }

      return {
        projects: updateProjectUiInList(
          state.projects,
          chat.projectId,
          (project) =>
            sanitizeProjectUiForChats(
              nextChats,
              chat.projectId,
              project.ui,
              ensureActiveChatForProject(
                nextChats,
                chat.projectId,
                project.ui.activeChatId === chatId
                  ? null
                  : project.ui.activeChatId,
              ),
            ),
        ),
        closedProjects: updateProjectUiInList(
          state.closedProjects,
          chat.projectId,
          (project) =>
            sanitizeProjectUiForChats(
              nextChats,
              chat.projectId,
              project.ui,
              ensureActiveChatForProject(
                nextChats,
                chat.projectId,
                project.ui.activeChatId === chatId
                  ? null
                  : project.ui.activeChatId,
              ),
            ),
        ),
        draftChatIdByProject: nextDraftChatIdByProject,
        chats: nextChats,
      };
    });
    get().persist();
  },

  permanentlyDeleteChats: (chatIds: string[]) => {
    const idsToDelete = new Set(chatIds);
    if (idsToDelete.size === 0) {
      return;
    }

    set((state) => {
      const deletedChats = state.chats.filter((chat) =>
        idsToDelete.has(chat.id),
      );
      if (deletedChats.length === 0) {
        return state;
      }

      const affectedProjectIds = new Set(
        deletedChats.map((chat) => chat.projectId),
      );
      const nextChats = state.chats.filter((chat) => !idsToDelete.has(chat.id));
      const nextMessagesByChatId = { ...state.messagesByChatId };
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };

      for (const chat of deletedChats) {
        delete nextMessagesByChatId[chat.id];
        if (nextDraftChatIdByProject[chat.projectId] === chat.id) {
          nextDraftChatIdByProject[chat.projectId] = null;
        }
      }

      return {
        projects: state.projects.map((project) =>
          affectedProjectIds.has(project.id)
            ? {
                ...project,
                ui: sanitizeProjectUiForChats(
                  nextChats,
                  project.id,
                  project.ui,
                  ensureActiveChatForProject(
                    nextChats,
                    project.id,
                    project.ui.activeChatId,
                  ),
                ),
              }
            : project,
        ),
        closedProjects: state.closedProjects.map((project) =>
          affectedProjectIds.has(project.id)
            ? {
                ...project,
                ui: sanitizeProjectUiForChats(
                  nextChats,
                  project.id,
                  project.ui,
                  ensureActiveChatForProject(
                    nextChats,
                    project.id,
                    project.ui.activeChatId,
                  ),
                ),
              }
            : project,
        ),
        draftChatIdByProject: nextDraftChatIdByProject,
        messagesByChatId: nextMessagesByChatId,
        chats: nextChats,
      };
    });
    get().persist();
  },

  restoreChats: (chatIds: string[]) => {
    const idsToRestore = new Set(chatIds);
    if (idsToRestore.size === 0) {
      return;
    }

    set((state) => ({
      chats: state.chats.map((chat) =>
        idsToRestore.has(chat.id) ? { ...chat, deletedAt: null } : chat,
      ),
    }));
    get().persist();
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
        chats: touchUpdatedAt
          ? state.chats.map((item) =>
              item.id === chatId
                ? {
                    ...item,
                    updatedAt: new Date().toISOString(),
                  }
                : item,
            )
          : state.chats,
      };
    });
  },

  setChatSort: (chatSort: ChatSortOrder) => set({ chatSort }),
});
