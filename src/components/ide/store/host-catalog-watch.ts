/**
 * Listening to one host's catalog events and applying them to the store:
 * changes another window or the host itself made, transcripts it saved,
 * turns starting and ending. This window's own changes come back as echoes
 * and are skipped. A `reset` (the host restarted, or this window was away
 * too long) re-reads the host's catalog, after hydration if it comes first.
 */
import { getCatalogEventsClient } from "@/lib/catalog-events";
import { CLIENT_ID } from "@/lib/client-id";
import { useIdeStore } from "../ide-store";

export const watchHostCatalog = (hostId: string) => {
  const client = getCatalogEventsClient(hostId);

  let stopWaiting: (() => void) | null = null;
  const reload = () => {
    if (useIdeStore.getState().stateHydrated) {
      void useIdeStore.getState().reloadCatalog(hostId);
      return;
    }
    if (stopWaiting) return;
    stopWaiting = useIdeStore.subscribe((state) => {
      if (!state.stateHydrated) return;
      stopWaiting?.();
      stopWaiting = null;
      void state.reloadCatalog(hostId);
    });
  };

  const removeEvents = client.onEvent((event) => {
    if (event.origin === CLIENT_ID) return;
    const store = useIdeStore.getState();
    if (event.kind === "changes") {
      store.applyCatalogChanges(
        event as Parameters<typeof store.applyCatalogChanges>[0],
        hostId,
      );
    } else if (
      event.kind === "transcript" &&
      typeof event.chatId === "string"
    ) {
      void store.applyCatalogTranscript(event.chatId);
    } else if (event.kind === "turn" && typeof event.chatId === "string") {
      store.setHostTurnRunning(event.chatId, event.running === true);
    }
  });
  const removeResets = client.onReset(reload);

  return () => {
    removeEvents();
    removeResets();
    stopWaiting?.();
  };
};
