/**
 * Chat activity: what a chat is doing, as this window's sessions and the
 * chat's host both see it. The store keeps the signals apart (a session
 * streaming here, a turn the host says runs, a question or approval waiting
 * on either, a message queued here). Readers ask one of the questions below
 * instead of combining the signals themselves.
 *
 * - Running: a turn runs, followed here or not. Another client's turn
 *   counts: it changes the chat's transcript and the project's files all
 *   the same.
 * - Waiting on its user: a question or tool approval is open, here or on
 *   the host.
 * - Accepts a message: nothing in this window stops a new message: no
 *   session here streams the chat and no message is queued for it. A turn
 *   running elsewhere does not stop one: the host queues the run.
 *
 * Not here: whether this window's own session for a chat is busy
 * (chat/chat-runtime.ts) and which transcripts it keeps (transcript-cache.ts).
 * Those are about this window, not about the chat.
 */
import type { ChatConfig } from "@/types/ide";
import type { IdeState } from "./store/ide-store-types";

/** The store's signals about chats. */
export type ChatActivityState = Pick<
  IdeState,
  | "awaitingAnswerChatIds"
  | "hostAwaitingApprovalChatIds"
  | "hostRunningChatIds"
  | "pendingChatSubmitByChatId"
  | "streamingChatIds"
>;

/** The signals, picked from the store (for a shallow-compared selector). */
export const selectChatActivity = (state: IdeState): ChatActivityState => ({
  awaitingAnswerChatIds: state.awaitingAnswerChatIds,
  hostAwaitingApprovalChatIds: state.hostAwaitingApprovalChatIds,
  hostRunningChatIds: state.hostRunningChatIds,
  pendingChatSubmitByChatId: state.pendingChatSubmitByChatId,
  streamingChatIds: state.streamingChatIds,
});

/** A turn runs in the chat: streamed here, or running on its host. */
export const isChatRunning = (state: ChatActivityState, chatId: string) =>
  Boolean(state.streamingChatIds[chatId] || state.hostRunningChatIds[chatId]);

/** A question or tool approval waits on the chat's user, here or on the host. */
export const isChatWaitingOnUser = (state: ChatActivityState, chatId: string) =>
  Boolean(
    state.awaitingAnswerChatIds[chatId] ||
      state.hostAwaitingApprovalChatIds[chatId],
  );

/**
 * A new message can go to the chat now: no session here streams it and no
 * message is queued for it. A turn on the host does not stop it.
 */
export const chatAcceptsMessage = (state: ChatActivityState, chatId: string) =>
  !state.streamingChatIds[chatId] && !state.pendingChatSubmitByChatId[chatId];

/** The projects with a chat running in them. */
export const projectIdsWithRunningChats = (
  state: ChatActivityState,
  chats: Pick<ChatConfig, "id" | "projectId">[],
): Set<string> =>
  new Set(
    chats
      .filter((chat) => isChatRunning(state, chat.id))
      .map((chat) => chat.projectId),
  );

/** Whether a chat runs in `projectId`: an agent may be changing its files. */
export const isProjectRunning = (
  state: ChatActivityState & Pick<IdeState, "chats">,
  projectId: string,
) =>
  state.chats.some(
    (chat) => chat.projectId === projectId && isChatRunning(state, chat.id),
  );

/** The chats waiting on their user, as one set. */
export const chatIdsWaitingOnUser = (
  state: ChatActivityState,
): Record<string, true> => {
  const waiting: Record<string, true> = {};
  for (const chatId of Object.keys(state.awaitingAnswerChatIds))
    if (state.awaitingAnswerChatIds[chatId]) waiting[chatId] = true;
  for (const chatId of Object.keys(state.hostAwaitingApprovalChatIds))
    if (state.hostAwaitingApprovalChatIds[chatId]) waiting[chatId] = true;
  return waiting;
};
