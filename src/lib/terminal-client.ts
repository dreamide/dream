/**
 * The terminal client: the renderer's one way to run terminals on the host.
 *
 * Starting, stopping and listing go through the route client's JSON routes.
 * Everything that streams (output and status from the host; input, resizes
 * and acknowledgments to it) is the host socket's terminal channel
 * (host-socket.ts; electron/api/terminals/terminal-stream.js). Its resume
 * cursor is where each live session's output stopped, so a reconnect
 * resends only what was missed; a batch received twice (live, then again in
 * the replay) is delivered once.
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
import { LOCAL_HOST_ID, resolveRequestHost } from "./host-routing";
import {
  getHostSocketClient,
  type HostSocketClient,
  type HostSocketMessage,
  hostSocketClient,
} from "./host-socket";

export const TERMINAL_CHANNEL = "terminal";

type TerminalRoutes = Pick<
  ApiClient,
  | "terminalDiagnostics"
  | "terminalShells"
  | "terminalStart"
  | "terminalStop"
  | "terminalStopAll"
>;

export interface TerminalClientOptions {
  api?: TerminalRoutes;
  socket?: HostSocketClient;
  /** The host the terminals run on; the local host when absent. */
  hostId?: string;
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

const withoutEnvelope = ({
  channel: _channel,
  type: _type,
  ...rest
}: HostSocketMessage) => rest;

export const createTerminalClient = ({
  api = apiClient,
  socket = hostSocketClient,
  hostId,
}: TerminalClientOptions = {}): TerminalClient => {
  const onHost = hostId ? { hostId } : undefined;
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const statusListeners = new Set<(event: TerminalStatusEvent) => void>();
  /** Where each live session's output stopped, as last received. */
  const cursors = new Map<string, Cursor>();

  const receive = (message: HostSocketMessage) => {
    if (message.type === "data") {
      const data = withoutEnvelope(message) as unknown as TerminalDataEvent;
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
      const status = withoutEnvelope(message) as unknown as TerminalStatusEvent;
      if (status.status === "stopped") cursors.delete(status.sessionId);
      for (const listener of statusListeners) listener(status);
    }
  };

  socket.register({
    name: TERMINAL_CHANNEL,
    cursor: () =>
      [...cursors].map(([sessionId, cursor]) => ({ sessionId, ...cursor })),
    receive,
  });

  const send = (type: string, payload: object) =>
    socket.send({ channel: TERMINAL_CHANNEL, type, ...payload });

  const listen = <Listener>(listeners: Set<Listener>, listener: Listener) => {
    listeners.add(listener);
    const release = socket.retain();
    return () => {
      listeners.delete(listener);
      release();
    };
  };

  return {
    detectShells: () => api.terminalShells({}, onHost),

    start: (payload) => {
      // Output can arrive before the socket is open; a cursor from the
      // start means the resume asks for all of it.
      cursors.set(payload.sessionId, { generation: null, sequence: 0 });
      socket.connect();
      return api.terminalStart(payload, onHost);
    },

    stop: (sessionId) => {
      cursors.delete(sessionId);
      return api.terminalStop({ sessionId }, onHost);
    },

    stopAll: (options) =>
      api.terminalStopAll({}, { ...onHost, keepalive: options?.keepalive }),

    getDiagnostics: () => api.terminalDiagnostics({}, onHost),

    sendInput: ({ sessionId, data }) => send("input", { sessionId, data }),

    resize: ({ sessionId, cols, rows }) =>
      send("resize", { sessionId, cols, rows }),

    acknowledge: ({ sessionId, generation, sequence }) =>
      send("ack", { sessionId, generation, sequence }),

    onData: (listener) => listen(dataListeners, listener),

    onStatus: (listener) => listen(statusListeners, listener),
  };
};

/**
 * Terminals on every host, as one client: each call goes to the host of the
 * session's project (host-routing.ts), and listeners hear every host.
 */
export const createMultiHostTerminalClient = (
  createForHost: (hostId: string) => TerminalClient = (hostId) =>
    createTerminalClient({
      hostId,
      socket: getHostSocketClient(hostId),
    }),
): TerminalClient & { forHost(hostId: string): TerminalClient } => {
  const clients = new Map<string, TerminalClient>();
  const dataListeners = new Map<
    (event: TerminalDataEvent) => void,
    Map<string, () => void>
  >();
  const statusListeners = new Map<
    (event: TerminalStatusEvent) => void,
    Map<string, () => void>
  >();

  const forHost = (hostId: string) => {
    let client = clients.get(hostId);
    if (!client) {
      client = createForHost(hostId);
      clients.set(hostId, client);
      for (const [listener, removers] of dataListeners) {
        removers.set(hostId, client.onData(listener));
      }
      for (const [listener, removers] of statusListeners) {
        removers.set(hostId, client.onStatus(listener));
      }
    }
    return client;
  };
  const forSession = (sessionId: string) =>
    forHost(resolveRequestHost({ sessionId }));
  forHost(LOCAL_HOST_ID);

  return {
    forHost,
    detectShells: () => forHost(LOCAL_HOST_ID).detectShells(),
    start: (payload) => forSession(payload.sessionId).start(payload),
    stop: (sessionId) => forSession(sessionId).stop(sessionId),
    stopAll: async (options) => {
      const results = await Promise.all(
        [...clients.values()].map((client) => client.stopAll(options)),
      );
      return results.every(Boolean);
    },
    getDiagnostics: async () =>
      (
        await Promise.all(
          [...clients.values()].map((client) => client.getDiagnostics()),
        )
      ).flat(),
    sendInput: (payload) => forSession(payload.sessionId).sendInput(payload),
    resize: (payload) => forSession(payload.sessionId).resize(payload),
    acknowledge: (payload) =>
      forSession(payload.sessionId).acknowledge(payload),
    onData: (listener) => {
      const removers = new Map<string, () => void>();
      for (const [hostId, client] of clients) {
        removers.set(hostId, client.onData(listener));
      }
      dataListeners.set(listener, removers);
      return () => {
        for (const remove of removers.values()) remove();
        dataListeners.delete(listener);
      };
    },
    onStatus: (listener) => {
      const removers = new Map<string, () => void>();
      for (const [hostId, client] of clients) {
        removers.set(hostId, client.onStatus(listener));
      }
      statusListeners.set(listener, removers);
      return () => {
        for (const remove of removers.values()) remove();
        statusListeners.delete(listener);
      };
    },
  };
};

/** The app's terminal client: every host's terminals. */
export const terminalClient = createMultiHostTerminalClient();
