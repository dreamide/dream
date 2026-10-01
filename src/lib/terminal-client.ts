/**
 * The terminal client: the renderer's one way to run terminals on the host.
 *
 * Starting, stopping and listing go through the route client's JSON routes.
 * Everything that streams (output and status from the host; input, resizes
 * and acknowledgments to it) travels over one WebSocket, the terminal
 * socket (electron/api/terminal-routes.js). The socket opens lazily with a
 * one-time ticket, reconnects with backoff, and on every (re)connect tells
 * the host where each session's output stopped ("resume") so the host
 * resends only what was missed. Messages sent while disconnected wait in an
 * outbox and go out after the resume.
 */
import type {
  StartTerminalPayload,
  TerminalDataEvent,
  TerminalInputPayload,
  TerminalOutputAcknowledgment,
  TerminalOutputDiagnostics,
  TerminalResizePayload,
  TerminalShellOption,
  TerminalStatusEvent,
} from "@/types/ide";
import {
  type ApiClient,
  apiClient,
  type TerminalStartResponse,
} from "./api-client";

export const TERMINAL_SOCKET_PATH = "/api/terminal-socket";

const OUTBOX_LIMIT = 10_000;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
const SOCKET_OPEN = 1;

/** The part of a browser WebSocket the client uses. */
export interface TerminalSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

type TerminalRoutes = Pick<
  ApiClient,
  | "terminalDiagnostics"
  | "terminalShells"
  | "terminalSocketTicket"
  | "terminalStart"
  | "terminalStop"
  | "terminalStopAll"
>;

export interface TerminalClientOptions {
  api?: TerminalRoutes;
  /** Opens the socket for a ticket; the browser's WebSocket by default. */
  openSocket?: (ticket: string) => TerminalSocket;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface TerminalClient {
  detectShells(): Promise<TerminalShellOption[]>;
  start(payload: StartTerminalPayload): Promise<TerminalStartResponse>;
  stop(sessionId: string): Promise<boolean>;
  stopAll(options?: { keepalive?: boolean }): Promise<boolean>;
  getDiagnostics(): Promise<TerminalOutputDiagnostics[]>;
  sendInput(payload: TerminalInputPayload): void;
  resize(payload: TerminalResizePayload): void;
  acknowledge(payload: TerminalOutputAcknowledgment): void;
  onData(listener: (event: TerminalDataEvent) => void): () => void;
  onStatus(listener: (event: TerminalStatusEvent) => void): () => void;
}

interface Cursor {
  generation: string | null;
  sequence: number;
}

const defaultOpenSocket = (ticket: string): TerminalSocket => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(
    `${protocol}//${window.location.host}${TERMINAL_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`,
  ) as unknown as TerminalSocket;
};

export const createTerminalClient = ({
  api = apiClient,
  openSocket = defaultOpenSocket,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: TerminalClientOptions = {}): TerminalClient => {
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const statusListeners = new Set<(event: TerminalStatusEvent) => void>();
  /** Where each live session's output stopped, as last received. */
  const cursors = new Map<string, Cursor>();
  let outbox: string[] = [];
  let socket: TerminalSocket | null = null;
  let connecting = false;
  let retryDelay = MIN_RETRY_MS;
  let retryTimer: unknown = null;

  const hasListeners = () => dataListeners.size + statusListeners.size > 0;

  const scheduleReconnect = () => {
    if (retryTimer !== null || !hasListeners()) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    retryTimer = setTimer(() => {
      retryTimer = null;
      ensureSocket();
    }, delay);
  };

  const receive = (text: unknown) => {
    if (typeof text !== "string") return;
    let message: { type?: string } & Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.type === "data") {
      const { type: _type, ...event } = message;
      const data = event as unknown as TerminalDataEvent;
      if (data.generation !== undefined && data.sequence !== undefined) {
        const cursor = cursors.get(data.sessionId);
        // A batch already received (sent live and again by the replay).
        if (
          cursor?.generation === data.generation &&
          data.sequence <= cursor.sequence
        ) {
          return;
        }
        cursors.set(data.sessionId, {
          generation: data.generation,
          sequence: data.sequence,
        });
      }
      for (const listener of dataListeners) listener(data);
      return;
    }

    if (message.type === "status") {
      const { type: _type, ...event } = message;
      const status = event as unknown as TerminalStatusEvent;
      if (status.status === "stopped") cursors.delete(status.sessionId);
      for (const listener of statusListeners) listener(status);
    }
  };

  const connect = async () => {
    let next: TerminalSocket;
    try {
      const { ticket } = await api.terminalSocketTicket({});
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
      next.send(
        JSON.stringify({
          type: "resume",
          sessions: [...cursors].map(([sessionId, cursor]) => ({
            sessionId,
            ...cursor,
          })),
        }),
      );
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

  const ensureSocket = () => {
    if (socket || connecting) return;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    connecting = true;
    void connect();
  };

  const send = (message: object) => {
    const text = JSON.stringify(message);
    if (socket && socket.readyState === SOCKET_OPEN) {
      socket.send(text);
      return;
    }
    if (outbox.length < OUTBOX_LIMIT) outbox.push(text);
    ensureSocket();
  };

  return {
    detectShells: () => api.terminalShells({}),

    start: (payload) => {
      // Output can arrive before the socket is open; a cursor from the
      // start means the resume asks for all of it.
      cursors.set(payload.sessionId, { generation: null, sequence: 0 });
      ensureSocket();
      return api.terminalStart(payload);
    },

    stop: (sessionId) => {
      cursors.delete(sessionId);
      return api.terminalStop({ sessionId });
    },

    stopAll: (options) =>
      api.terminalStopAll({}, { keepalive: options?.keepalive }),

    getDiagnostics: () => api.terminalDiagnostics({}),

    sendInput: ({ sessionId, data }) =>
      send({ type: "input", sessionId, data }),

    resize: ({ sessionId, cols, rows }) =>
      send({ type: "resize", sessionId, cols, rows }),

    acknowledge: ({ sessionId, generation, sequence }) =>
      send({ type: "ack", sessionId, generation, sequence }),

    onData: (listener) => {
      dataListeners.add(listener);
      ensureSocket();
      return () => {
        dataListeners.delete(listener);
      };
    },

    onStatus: (listener) => {
      statusListeners.add(listener);
      ensureSocket();
      return () => {
        statusListeners.delete(listener);
      };
    },
  };
};

/** The app's terminal client, against the local host. */
export const terminalClient = createTerminalClient();
