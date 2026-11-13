import { chatAcceptsMessage } from "../chat-activity";
import { useIdeStore } from "../ide-store";

/**
 * Whether a saved prompt can be sent to `chatId` right now: the chat exists
 * in the active project and accepts a message (chat-activity.ts).
 */
export const useChatAcceptsSavedPrompt = (chatId: string | null): boolean =>
  useIdeStore((state) => {
    if (chatId === null) {
      return false;
    }
    const chat = state.chats.find((entry) => entry.id === chatId);
    return (
      chat !== undefined &&
      chat.deletedAt === null &&
      chat.projectId === state.activeProjectId &&
      chatAcceptsMessage(state, chatId)
    );
  });
