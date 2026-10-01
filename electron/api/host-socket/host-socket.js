// The host socket: one WebSocket per client per host, carrying every kind of
// live traffic between them. Each message names its `channel`; this module
// owns the clients and hands each message to its channel.
//
//   terminal   terminal output, status, input (terminals/terminal-stream.js)
//   catalog    host catalog changes (catalog-events.js)
//   host       the socket's own messages: `resume`
//
// A client that (re)connects sends one resume message with every channel's
// cursor, {channel: "host", type: "resume", cursors: {terminal, catalog}},
// and each channel sends that client what it missed.
import { createTerminalStream } from "../terminals/terminal-stream.js";
import { CATALOG_CHANNEL, createCatalogEvents } from "./catalog-events.js";

export const HOST_CHANNEL = "host";

export function createHostSocket({ terminalReplayBudget, catalogRetain } = {}) {
  /** @type {Set<{ send: (text: string) => void }>} */
  const clients = new Set();

  const sendTo = (client, message) => {
    try {
      client.send(JSON.stringify(message));
    } catch {
      // A client whose socket is closing is dropped by its close handler.
    }
  };

  const broadcast = (message) => {
    for (const client of clients) sendTo(client, message);
  };

  const terminals = createTerminalStream({
    broadcast,
    replayBudget: terminalReplayBudget,
  });
  const catalog = createCatalogEvents({ broadcast, retain: catalogRetain });
  const channels = { [CATALOG_CHANNEL]: catalog, terminal: terminals };

  const receive = (client, text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.channel === HOST_CHANNEL && message.type === "resume") {
      const cursors =
        message.cursors && typeof message.cursors === "object"
          ? message.cursors
          : {};
      const send = (reply) => sendTo(client, reply);
      for (const [name, channel] of Object.entries(channels)) {
        channel.resume(send, cursors[name]);
      }
      return;
    }

    channels[message.channel]?.receive(message);
  };

  return {
    /** The terminal channel; the process-session manager publishes to it. */
    terminals,
    /** The catalog channel; the host catalog publishes its changes to it. */
    catalog,

    /**
     * Attaches a client. Returns its handlers: `receive` for each text
     * message it sends, `close` when its socket goes away.
     * @param {{ send: (text: string) => void }} client
     */
    connect(client) {
      clients.add(client);
      return {
        receive: (text) => receive(client, text),
        close: () => {
          clients.delete(client);
        },
      };
    },

    getClientCount: () => clients.size,
  };
}
