import type { UIMessage } from "ai";
import { createChatConfig, getDefaultModelSelection } from "@/lib/ide-defaults";
import type { ChatConfig, ChatSortOrder, ProjectUiState } from "@/types/ide";
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
        chats: [...state.chats, nextChat],
      };
    });
  },

  addChatBeside: (projectId: string) => {
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
        chats: nextChats,
      };
    });
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

      const nextCompletedChatIds = { ...state.completedChatIds };
      if (nextActiveChatId) {
        delete nextCompletedChatIds[nextActiveChatId];
      }

      return {
        completedChatIds: nextCompletedChatIds,
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
    let projectIdNeedingNewChat: string | null = null;

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
      const sanitizeUiAfterDelete = (project: { ui: ProjectUiState }) => {
        const deletedOpenIndex = project.ui.openChatIds.indexOf(chatId);
        const openChatIds = project.ui.openChatIds.filter(
          (openChatId) => openChatId !== chatId,
        );
        const preferredActiveChatId =
          project.ui.activeChatId === chatId
            ? (openChatIds[deletedOpenIndex] ??
              openChatIds[deletedOpenIndex - 1] ??
              null)
            : project.ui.activeChatId;

        if (project.ui.activeChatId === chatId && openChatIds.length === 0) {
          projectIdNeedingNewChat = chat.projectId;
        }

        return sanitizeProjectUiForChats(
          nextChats,
          chat.projectId,
          {
            ...project.ui,
            openChatIds,
          },
          preferredActiveChatId,
        );
      };

      const nextCompletedChatIds = { ...state.completedChatIds };
      delete nextCompletedChatIds[chatId];

      return {
        completedChatIds: nextCompletedChatIds,
        projects: updateProjectUiInList(
          state.projects,
          chat.projectId,
          sanitizeUiAfterDelete,
        ),
        closedProjects: updateProjectUiInList(
          state.closedProjects,
          chat.projectId,
          sanitizeUiAfterDelete,
        ),
        draftChatIdByProject: nextDraftChatIdByProject,
        chats: nextChats,
      };
    });

    if (projectIdNeedingNewChat) {
      get().addChat(projectIdNeedingNewChat);
    }

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
      const nextCompletedChatIds = { ...state.completedChatIds };

      for (const chat of deletedChats) {
        delete nextMessagesByChatId[chat.id];
        delete nextCompletedChatIds[chat.id];
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
        completedChatIds: nextCompletedChatIds,
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
