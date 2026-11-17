import type { SendChatMessage } from "../chat/chat-submission";

/**
 * How store actions send a message to a chat. Chat submission
 * (chat/chat-submission.ts) reaches the store through the chat runtime, so
 * the store cannot import it; it registers its entry point here when it
 * loads, as the store registers the host resolver (host-routing.ts).
 */
let submitter: SendChatMessage | null = null;

export const setChatSubmitter = (next: SendChatMessage | null) => {
  submitter = next;
};

/** `sendChatMessage`, for store actions. */
export const sendToChat: SendChatMessage = (chatId, submission, options) => {
  if (!submitter) throw new Error("Chat submission is not loaded.");
  return submitter(chatId, submission, options);
};
