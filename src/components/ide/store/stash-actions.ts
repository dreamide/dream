import { createStashItem } from "@/lib/ide-defaults";
import type { StashItem } from "@/types/ide";
import { getFirstActiveDiffChatId } from "../diff-feedback";
import { sendToChat } from "./chat-submitter";
import { updateProjectUiInList } from "./helpers";
import type { IdeStoreGet, IdeStoreSet } from "./ide-store-types";

const getProjectStashItems = (
  project: { ui: { stashItems?: StashItem[] } } | undefined,
) => project?.ui.stashItems ?? [];

/** The stash actions in the store (`IdeState`). */
export interface StashActions {
  addStashItem: (
    projectId: string,
    item: Omit<StashItem, "createdAt" | "id" | "updatedAt">,
  ) => string | null;
  updateStashItem: (
    projectId: string,
    itemId: string,
    updater: (item: StashItem) => StashItem,
  ) => void;
  deleteStashItem: (projectId: string, itemId: string) => void;
  /**
   * Sends a stash item to its chat (a new one, or the first active diff
   * chat) and removes it from the stash. Returns the chat, or null when the
   * item cannot go anywhere. A message the chat does not take goes to the
   * chat's draft (chat/chat-submission.ts).
   */
  executeStashItem: (projectId: string, itemId: string) => string | null;
}

export const createStashActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): StashActions => ({
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
