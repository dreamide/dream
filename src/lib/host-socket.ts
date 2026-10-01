/**
 * The host socket, client side: one WebSocket to the host carrying every
 * kind of live traffic (electron/api/host-socket/host-socket.js). Each
 * message names its `channel`; channels register here (the terminal client,
 * the catalog events client) and this module owns the connection they share.
 *
 * The socket opens with a one-time ticket, stays open while anyone has
 * retained it, and reconnects with backoff. On every (re)connect it sends
 * one resume message with each channel's cursor, so the host resends only
 * what each channel missed. Messages sent while disconnected wait in an
 * outbox and go out after the resume.
 */
import { type ApiClient, apiClient } from "./api-client";

export const HOST_SOCKET_PATH = "/api/host-socket";

const OUTBOX_LIMIT = 10_000;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
const SOCKET_OPEN = 1;

/** The part of a browser WebSocket the client uses. */
export interface HostSocketTransport {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface HostSocketMessage {
  channel: string;
  type: string;
  [key: string]: unknown;
}

/** One kind of traffic on the socket. */
export interface HostSocketChannel {
  name: string;
  /** Where this channel stopped, sent in every resume. */
  cursor(): unknown;
  /** A message the host sent on this channel. */
  receive(message: HostSocketMessage): void;
}

export interface HostSocketClient {
  /** Adds a channel; returns its removal. */
  register(channel: HostSocketChannel): () => void;
  /** Sends now, or after the next (re)connect's resume. */
  send(message: HostSocketMessage): void;
  /** Keeps the socket connected until the returned release is called. */
  retain(): () => void;
  /** Opens the socket now if it is closed (without retaining it). */
  connect(): void;
}

export interface HostSocketClientOptions {
  api?: Pick<ApiClient, "hostSocketTicket">;
  /** Opens the socket for a ticket; the browser's WebSocket by default. */
  openSocket?: (ticket: string) => HostSocketTransport;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const defaultOpenSocket = (ticket: string): HostSocketTransport => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(
    `${protocol}//${window.location.host}${HOST_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`,
  ) as unknown as HostSocketTransport;
};

export const createHostSocketClient = ({
  api = apiClient,
  openSocket = defaultOpenSocket,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: HostSocketClientOptions = {}): HostSocketClient => {
  const channels = new Map<string, HostSocketChannel>();
  let retained = 0;
  let outbox: string[] = [];
  let socket: HostSocketTransport | null = null;
  let connecting = false;
  let retryDelay = MIN_RETRY_MS;
  let retryTimer: unknown = null;

  const scheduleReconnect = () => {
    if (retryTimer !== null || retained === 0) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    retryTimer = setTimer(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const receive = (text: unknown) => {
    if (typeof text !== "string") return;
    let message: HostSocketMessage;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message && typeof message.channel === "string") {
      channels.get(message.channel)?.receive(message);
    }
  };

  const open = async () => {
    let next: HostSocketTransport;
    try {
      const { ticket } = await api.hostSocketTicket({});
      next = openSocket(ticket);
    } catch {
      connecting = false;
      scheduleReconnect();
      return;
    }

    socket = next;
    next.onopen = () => {
      connecting = false;
      retryDelay = MIN_RETRY_MS;
      const cursors: Record<string, unknown> = {};
      for (const [name, channel] of channels) cursors[name] = channel.cursor();
      next.send(JSON.stringify({ channel: "host", type: "resume", cursors }));
      const pending = outbox;
      outbox = [];
      for (const text of pending) next.send(text);
    };
    next.onmessage = (event) => receive(event.data);
    next.onclose = () => {
      if (socket === next) socket = null;
      connecting = false;
      scheduleReconnect();
    };
    next.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  };

  const connect = () => {
    if (socket || connecting) return;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    connecting = true;
    void open();
  };

  return {
    register(channel) {
      channels.set(channel.name, channel);
      return () => {
        if (channels.get(channel.name) === channel) {
          channels.delete(channel.name);
        }
      };
    },

    send(message) {
      const text = JSON.stringify(message);
      if (socket && socket.readyState === SOCKET_OPEN) {
        socket.send(text);
        return;
      }
      if (outbox.length < OUTBOX_LIMIT) outbox.push(text);
      connect();
    },

    retain() {
      retained += 1;
      connect();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained -= 1;
      };
    },

    connect,
  };
};

/** The app's host socket, to the local host. */
export const hostSocketClient = createHostSocketClient();
