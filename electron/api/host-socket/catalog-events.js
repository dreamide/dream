// The catalog channel of the host socket: changes to the host catalog
// (projects, chats, turns) as an ordered log, so every client hears about a
// change whoever made it.
//
// Each event is stamped with the host's `epoch` (random per host process)
// and a `seq` that increases by one. A client keeps the last {epoch, seq} it
// saw and sends it when it reconnects. The host replays what came after it
// while that is still retained; otherwise (a new client, a restarted host,
// a cursor older than what is kept) it answers `reset` with the current
// cursor, and the client refetches the catalog over the JSON routes and
// carries on from there. Applying an event the refetch already reflected
// must be harmless.
//
// Messages, all with `channel: "catalog"`:
//   host -> client   event {epoch, seq, event}
//                    reset {epoch, seq}
// Its resume cursor: {epoch, seq} or null.
import { randomUUID } from "node:crypto";

export const CATALOG_CHANNEL = "catalog";
export const CATALOG_EVENTS_RETAINED = 1000;

/**
 * @param {{
 *   broadcast: (message: object) => void,
 *   retain?: number,
 *   epoch?: string,
 * }} options
 */
export function createCatalogEvents({
  broadcast,
  retain = CATALOG_EVENTS_RETAINED,
  epoch = randomUUID(),
}) {
  /** @type {{ seq: number, event: object }[]} */
  const retained = [];
  let seq = 0;

  const eventMessage = (entry) => ({
    channel: CATALOG_CHANNEL,
    type: "event",
    epoch,
    seq: entry.seq,
    event: entry.event,
  });

  return {
    /**
     * Records a change and tells every client.
     * @param {{ kind: string } & Record<string, unknown>} event
     */
    publish(event) {
      seq += 1;
      const entry = { seq, event };
      retained.push(entry);
      if (retained.length > retain) retained.shift();
      broadcast(eventMessage(entry));
    },

    /** Where the log is now. */
    getCursor: () => ({ epoch, seq }),

    /**
     * Sends a reconnecting client the events after its cursor, or `reset`.
     * @param {(message: object) => void} send to that client only
     * @param {unknown} cursor the channel's resume cursor
     */
    resume(send, cursor) {
      const oldest = retained[0]?.seq ?? seq + 1;
      const usable =
        cursor &&
        typeof cursor === "object" &&
        cursor.epoch === epoch &&
        Number.isInteger(cursor.seq) &&
        cursor.seq <= seq &&
        cursor.seq >= oldest - 1;
      if (!usable) {
        send({ channel: CATALOG_CHANNEL, type: "reset", epoch, seq });
        return;
      }
      for (const entry of retained) {
        if (entry.seq > cursor.seq) send(eventMessage(entry));
      }
    },

    /** Clients send nothing on this channel. */
    receive() {},
  };
}
