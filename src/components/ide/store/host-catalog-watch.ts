/**
 * Listening to one host's catalog events and applying them to the store:
 * changes another window or the host itself made, transcripts it saved,
 * turns starting and ending. This window's own changes come back as echoes
 * and are skipped. A `reset` (the host restarted, or this window was away
 * too long) re-reads the host's catalog, after hydration if it comes first.
 */
import { getCatalogEventsClient } from "@/lib/catalog-events";
import { refreshChatQueue, useChatQueueStore } from "@/lib/chat-queue";
import { CLIENT_ID } from "@/lib/client-id";
import { useIdeStore } from "../ide-store";

export const watchHostCatalog = (hostId: string) => {
  const client = getCatalogEventsClient(hostId);

  let stopWaiting: (() => void) | null = null;
  const reload = () => {
    for (const chatId of Object.keys(useChatQueueStore.getState().queues))
      void refreshChatQueue(chatId);
    if (useIdeStore.getState().stateHydrated) {
      void useIdeStore
        .getState()
        .refreshHostCatalog(hostId)
        .catch((error: unknown) => {
          console.warn(
            `Unable to refresh the catalog of host ${hostId}.`,
            error,
          );
        });
      return;
    }
    if (stopWaiting) return;
    stopWaiting = useIdeStore.subscribe((state) => {
      if (!state.stateHydrated) return;
      stopWaiting?.();
      stopWaiting = null;
      void state.refreshHostCatalog(hostId).catch((error: unknown) => {
        console.warn(`Unable to refresh the catalog of host ${hostId}.`, error);
      });
    });
  };

  const removeEvents = client.onEvent((event) => {
    if (event.origin === CLIENT_ID) return;
    const store = useIdeStore.getState();
    if (event.kind === "queue" && typeof event.chatId === "string") {
      void refreshChatQueue(event.chatId);
      return;
    }
    if (event.kind === "changes") {
      store.applyCatalogChanges(
        event as Parameters<typeof store.applyCatalogChanges>[0],
        hostId,
      );
    } else if (
      event.kind === "transcript" &&
      typeof event.chatId === "string"
    ) {
      void store.applyCatalogTranscript(event.chatId, {
        ...(typeof event.messageCount === "number"
          ? { messageCount: event.messageCount }
          : {}),
      });
    } else if (event.kind === "turn" && typeof event.chatId === "string") {
      store.setHostTurnRunning(event.chatId, event.running === true);
    } else if (event.kind === "approval" && typeof event.chatId === "string") {
      store.setHostChatAwaitingApproval(event.chatId, event.awaiting === true);
    }
  });
  const removeResets = client.onReset(reload);

  return () => {
    removeEvents();
    removeResets();
    stopWaiting?.();
  };
};
