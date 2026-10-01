/**
 * Host catalog changes, client side: the host socket's catalog channel
 * (electron/api/host-socket/catalog-events.js).
 *
 * Events arrive in order, stamped {epoch, seq}. The client keeps the last
 * cursor it saw and resumes from it. When the host cannot replay from there
 * (a first connect, a restarted host, a cursor older than the host keeps)
 * it sends `reset`, and whoever holds the catalog must refetch it from the
 * JSON routes; events after that apply on top. An event from an epoch the
 * client has not been reset into is treated as a reset too.
 */
import {
  type HostSocketClient,
  type HostSocketMessage,
  hostSocketClient,
} from "./host-socket";

export const CATALOG_CHANNEL = "catalog";

export interface CatalogCursor {
  epoch: string;
  seq: number;
}

/** A host catalog change; its fields depend on `kind`. */
export interface CatalogEvent {
  kind: string;
  [key: string]: unknown;
}

export interface CatalogEventsClient {
  /** Each change, once, in order. */
  onEvent(
    listener: (event: CatalogEvent, cursor: CatalogCursor) => void,
  ): () => void;
  /** The catalog must be refetched; events continue from `cursor`. */
  onReset(listener: (cursor: CatalogCursor) => void): () => void;
  getCursor(): CatalogCursor | null;
}

export const createCatalogEventsClient = ({
  socket = hostSocketClient,
}: {
  socket?: HostSocketClient;
} = {}): CatalogEventsClient => {
  const eventListeners = new Set<
    (event: CatalogEvent, cursor: CatalogCursor) => void
  >();
  const resetListeners = new Set<(cursor: CatalogCursor) => void>();
  let cursor: CatalogCursor | null = null;

  const reset = (next: CatalogCursor) => {
    cursor = next;
    for (const listener of resetListeners) listener(next);
  };

  const receive = (message: HostSocketMessage) => {
    const { epoch, seq } = message;
    if (typeof epoch !== "string" || typeof seq !== "number") return;

    if (message.type === "reset") {
      reset({ epoch, seq });
      return;
    }
    if (message.type !== "event") return;

    if (!cursor || cursor.epoch !== epoch) {
      // Nothing to apply this on top of: start over from here.
      reset({ epoch, seq });
      return;
    }
    if (seq <= cursor.seq) return;
    cursor = { epoch, seq };
    const event = message.event as CatalogEvent;
    for (const listener of eventListeners) listener(event, cursor);
  };

  socket.register({ name: CATALOG_CHANNEL, cursor: () => cursor, receive });

  const listen = <Listener>(listeners: Set<Listener>, listener: Listener) => {
    listeners.add(listener);
    const release = socket.retain();
    return () => {
      listeners.delete(listener);
      release();
    };
  };

  return {
    onEvent: (listener) => listen(eventListeners, listener),
    onReset: (listener) => listen(resetListeners, listener),
    getCursor: () => cursor,
  };
};
