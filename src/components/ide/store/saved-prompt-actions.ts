import { createSavedPrompt } from "@/lib/ide-defaults";
import type { SavedPrompt } from "@/types/ide";
import type { ChatSendResult } from "../chat/chat-submission";
import { sendToChat } from "./chat-submitter";
import type { IdeStoreGet, IdeStoreSet } from "./ide-store-types";

const replaceSavedPrompt = (
  savedPrompts: SavedPrompt[],
  promptId: string,
  updater: (savedPrompt: SavedPrompt) => SavedPrompt,
): SavedPrompt[] => {
  let changed = false;
  const next = savedPrompts.map((savedPrompt) => {
    if (savedPrompt.id !== promptId) {
      return savedPrompt;
    }
    const updated = updater(savedPrompt);
    changed ||= updated !== savedPrompt;
    return updated;
  });
  return changed ? next : savedPrompts;
};

/** The saved prompt actions in the store (`IdeState`). */
export interface SavedPromptActions {
  /** Saves a new saved prompt at the end of the list. Returns its id. */
  addSavedPrompt: (savedPrompt: {
    name: string;
    prompt: string;
  }) => string | null;
  updateSavedPrompt: (
    promptId: string,
    updates: { name?: string; prompt?: string },
  ) => void;
  deleteSavedPrompt: (promptId: string) => void;
  moveSavedPrompt: (promptId: string, index: number) => void;
  /**
   * Sends a saved prompt's text, as written, to `chatId` in `projectId`.
   * Null when the prompt or chat is not there or the prompt is empty;
   * otherwise what Chat submission answered (chat/chat-submission.ts).
   */
  runSavedPrompt: (
    projectId: string,
    promptId: string,
    chatId: string,
  ) => Promise<ChatSendResult> | null;
}

export const createSavedPromptActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): SavedPromptActions => ({
  addSavedPrompt: ({ prompt, name }) => {
    if (!name.trim() || !prompt.trim()) {
      return null;
    }

    const savedPrompt = createSavedPrompt({ prompt, name });
    set((state) => ({ savedPrompts: [...state.savedPrompts, savedPrompt] }));
    return savedPrompt.id;
  },

  updateSavedPrompt: (promptId, updates) => {
    set((state) => {
      const savedPrompts = replaceSavedPrompt(
        state.savedPrompts,
        promptId,
        (savedPrompt) => {
          const name = updates.name?.trim() || savedPrompt.name;
          const prompt = updates.prompt?.trim() || savedPrompt.prompt;
          return name === savedPrompt.name && prompt === savedPrompt.prompt
            ? savedPrompt
            : {
                ...savedPrompt,
                prompt,
                name,
                updatedAt: new Date().toISOString(),
              };
        },
      );
      return savedPrompts === state.savedPrompts ? state : { savedPrompts };
    });
  },

  deleteSavedPrompt: (promptId) => {
    set((state) =>
      state.savedPrompts.some((savedPrompt) => savedPrompt.id === promptId)
        ? {
            savedPrompts: state.savedPrompts.filter(
              (savedPrompt) => savedPrompt.id !== promptId,
            ),
          }
        : state,
    );
  },

  moveSavedPrompt: (promptId, index) => {
    set((state) => {
      const from = state.savedPrompts.findIndex(
        (savedPrompt) => savedPrompt.id === promptId,
      );
      if (from < 0) {
        return state;
      }
      const to = Math.max(0, Math.min(index, state.savedPrompts.length - 1));
      if (from === to) {
        return state;
      }
      const savedPrompts = [...state.savedPrompts];
      const [savedPrompt] = savedPrompts.splice(from, 1);
      savedPrompts.splice(to, 0, savedPrompt as SavedPrompt);
      return { savedPrompts };
    });
  },

  runSavedPrompt: (projectId, promptId, chatId) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    const savedPrompt = state.savedPrompts.find(
      (entry) => entry.id === promptId,
    );
    const chat = state.chats.find((entry) => entry.id === chatId);
    if (
      !project ||
      !savedPrompt ||
      !chat ||
      chat.projectId !== projectId ||
      chat.deletedAt !== null
    ) {
      return null;
    }

    const text = savedPrompt.prompt.trim();
    if (!text) return null;
    // A prompt the chat does not take lands in its draft instead of being lost.
    return sendToChat(
      chatId,
      { references: [], text },
      { origin: "saved-prompt" },
    );
  },
});
