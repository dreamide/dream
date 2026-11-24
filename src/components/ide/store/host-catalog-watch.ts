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
import { readAgentTurnEnding } from "../../../../electron/shared/agent-turn-contract.js";
import type { CatalogChanges, HostCatalog } from "./catalog-actions";
import type { FollowedStore } from "./host-reach";

/** What the watcher applies events through (store/catalog-actions.ts). */
export type CatalogEventTarget = Pick<
  HostCatalog,
  "applyCatalogChanges" | "setHostChatAwaitingApproval" | "setHostTurnRunning"
>;

export const watchHostCatalog = (
  hostId: string,
  store: FollowedStore,
  catalog: CatalogEventTarget,
) => {
  const client = getCatalogEventsClient(hostId);

  let stopWaiting: (() => void) | null = null;
  const reload = () => {
    for (const chatId of Object.keys(useChatQueueStore.getState().queues))
      void refreshChatQueue(chatId);
    if (store.getState().stateHydrated) {
      void store
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
    stopWaiting = store.subscribe((state) => {
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
    const state = store.getState();
    if (event.kind === "queue" && typeof event.chatId === "string") {
      void refreshChatQueue(event.chatId);
      return;
    }
    if (event.kind === "changes") {
      catalog.applyCatalogChanges(event as CatalogChanges, hostId);
    } else if (
      event.kind === "transcript" &&
      typeof event.chatId === "string"
    ) {
      void state.applyCatalogTranscript(event.chatId, {
        ...(typeof event.messageCount === "number"
          ? { messageCount: event.messageCount }
          : {}),
      });
    } else if (event.kind === "turn" && typeof event.chatId === "string") {
      catalog.setHostTurnRunning(
        event.chatId,
        event.running === true,
        readAgentTurnEnding(event.ending),
      );
    } else if (event.kind === "approval" && typeof event.chatId === "string") {
      catalog.setHostChatAwaitingApproval(
        event.chatId,
        event.awaiting === true,
      );
    }
  });
  const removeResets = client.onReset(reload);

  return () => {
    removeEvents();
    removeResets();
    stopWaiting?.();
  };
};
