import { createStashItem } from "@/lib/ide-defaults";
import type { StashItem } from "@/types/ide";
import { getFirstActiveDiffChatId } from "../diff-feedback";
import { sendToChat } from "./chat-submitter";
import { updateProjectUiInList } from "./helpers";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

const getProjectStashItems = (
  project: { ui: { stashItems?: StashItem[] } } | undefined,
) => project?.ui.stashItems ?? [];

export const createStashActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  "addStashItem" | "updateStashItem" | "deleteStashItem" | "executeStashItem"
> => ({
  addStashItem: (projectId, item) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) {
      return null;
    }

    const text = item.text.trim();
    if (!text && item.references.length === 0) {
      return null;
    }

    const nextItem = createStashItem(project, {
      ...item,
      text,
    });

    set({
      projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
        ...entry.ui,
        stashItems: [...getProjectStashItems(entry), nextItem],
      })),
    });

    return nextItem.id;
  },

  updateStashItem: (projectId, itemId, updater) => {
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) {
        return state;
      }

      const currentItems = getProjectStashItems(project);
      const currentItem = currentItems.find((item) => item.id === itemId);
      if (!currentItem) {
        return state;
      }

      const nextItem = {
        ...updater(currentItem),
        id: currentItem.id,
        createdAt: currentItem.createdAt,
        updatedAt: new Date().toISOString(),
      };

      return {
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          stashItems: getProjectStashItems(entry).map((item) =>
            item.id === itemId ? nextItem : item,
          ),
        })),
      };
    });
  },

  deleteStashItem: (projectId, itemId) => {
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) {
        return state;
      }

      const currentItems = getProjectStashItems(project);
      if (!currentItems.some((item) => item.id === itemId)) {
        return state;
      }

      return {
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          stashItems: getProjectStashItems(entry).filter(
            (item) => item.id !== itemId,
          ),
        })),
      };
    });
  },

  executeStashItem: (projectId, itemId) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    const item = getProjectStashItems(project).find(
      (entry) => entry.id === itemId,
    );
    if (!project || !item || state.activeProjectId !== projectId) {
      return null;
    }

    if (!item.text.trim() && item.references.length === 0) {
      return null;
    }

    const newChat = item.newChat !== false;
    const chatId = newChat
      ? project.ui.multiChat
        ? get().addChatBeside(projectId)
        : get().addChat(projectId, undefined, { forceNew: true })
      : getFirstActiveDiffChatId(project, state.chats);
    if (!chatId) {
      return null;
    }

    if (newChat)
      get().updateChat(chatId, (chat) => ({
        ...chat,

        model: item.model,
        modelSpeed: item.modelSpeed,
        permissionMode: item.permissionMode,
        provider: item.provider,
        reasoningEffort: item.reasoningEffort,
        remoteConversationId: null,
        remoteConversationModel: null,
        remoteConversationModelSpeed: null,
        remoteConversationProjectPath: null,
      }));

    // Let go of at once: a message the chat does not take goes to its draft.
    void sendToChat(
      chatId,
      { references: item.references, text: item.text },
      { origin: "stash" },
    );

    set((current) => ({
      projects: updateProjectUiInList(current.projects, projectId, (entry) => ({
        ...entry.ui,
        stashItems: getProjectStashItems(entry).filter(
          (stashItem) => stashItem.id !== itemId,
        ),
      })),
    }));

    return chatId;
  },
});
