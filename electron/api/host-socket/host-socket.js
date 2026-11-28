// The host socket: one WebSocket per client per host, carrying every kind of
// live traffic between them. Each message names its `channel`; this module
// owns the clients and hands each message to its channel.
//
//   terminal   terminal output, status, input (terminals/terminal-stream.js)
//   catalog    host catalog changes (catalog-events.js)
//   browser    agents' browser tool calls, run in a window (browser-relay.js)
//   host       the socket's own messages: `resume`
//
// A client that (re)connects sends one resume message with every channel's
// cursor, {channel: "host", type: "resume", cursors: {terminal, catalog}},
// and each channel sends that client what it missed. A channel that talks
// to one client in particular gets that client with each message and is
// told when it closes.
//
// A client may be limited in what it sends (a paired device's scopes,
// host/auth/route-policy.js): a message, or a channel's resume, it may not
// send is dropped. What is broadcast reaches every client.
import { createTerminalStream } from "../terminals/terminal-stream.js";
import { BROWSER_CHANNEL, createBrowserRelay } from "./browser-relay.js";
import { CATALOG_CHANNEL, createCatalogEvents } from "./catalog-events.js";

export const HOST_CHANNEL = "host";

export function createHostSocket({
  terminalReplayBudget,
  catalogRetain,
  browserCallTimeoutMs,
} = {}) {
  /** @type {Set<{ send: (text: string) => void }>} */
  const clients = new Set();

  const sendRaw = (client, text) => {
    try {
      client.send(text);
    } catch {
      // A client whose socket is closing is dropped by its close handler.
    }
  };

  const sendTo = (client, message) => {
    sendRaw(client, JSON.stringify(message));
  };

  const broadcast = (message) => {
    if (clients.size === 0) return;
    const text = JSON.stringify(message);
    for (const client of clients) sendRaw(client, text);
  };

  const terminals = createTerminalStream({
    broadcast,
    replayBudget: terminalReplayBudget,
  });
  const catalog = createCatalogEvents({ broadcast, retain: catalogRetain });
  const browser = createBrowserRelay({ timeoutMs: browserCallTimeoutMs });
  const channels = {
    [BROWSER_CHANNEL]: browser,
    [CATALOG_CHANNEL]: catalog,
    terminal: terminals,
  };

  const receive = (client, allows, text) => {
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
        if (!allows(name, message)) continue;
        channel.resume(send, cursors[name], client);
      }
      return;
    }

    if (
      typeof message.channel !== "string" ||
      !allows(message.channel, message)
    )
      return;
    channels[message.channel]?.receive(
      message,
      (reply) => sendTo(client, reply),
      client,
    );
  };

  return {
    /** The terminal channel; the process-session manager publishes to it. */
    terminals,
    /** The catalog channel; the host catalog publishes its changes to it. */
    catalog,
    /** The browser channel; agents' browser tools call windows through it. */
    browser,

    /**
     * Attaches a client. Returns its handlers: `receive` for each text
     * message it sends, `close` when its socket goes away. `allows` says
     * whether it may send a message on a channel (a resume is checked per
     * channel); everything by default.
     * @param {{ send: (text: string) => void }} client
     * @param {{ allows?: (channel: string, message: { type?: unknown }) => boolean }} [options]
     */
    connect(client, { allows = () => true } = {}) {
      clients.add(client);
      return {
        receive: (text) => receive(client, allows, text),
        close: () => {
          clients.delete(client);
          for (const channel of Object.values(channels)) {
            channel.close?.(client);
          }
        },
      };
    },

    getClientCount: () => clients.size,
  };
}
