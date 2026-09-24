import { useIdeStore } from "../ide-store";

/**
 * Whether a task can be sent to `chatId` right now: the chat exists and is not
 * already streaming or holding a queued prompt. Mirrors `queueChatSubmit`.
 */
export const useChatAcceptsTask = (chatId: string | null): boolean =>
  useIdeStore((state) => {
    if (chatId === null) {
      return false;
    }
    const chat = state.chats.find((entry) => entry.id === chatId);
    return (
      chat !== undefined &&
      chat.deletedAt === null &&
      chat.projectId === state.activeProjectId &&
      !state.streamingChatIds[chatId] &&
      !state.pendingChatSubmitByChatId[chatId]
    );
  });
