// The host: everything a project needs from the machine it lives on (its
// files, the agent CLIs, terminals, git and the state database) behind one
// HTTP + WebSocket API. Nothing here imports Electron (host-boundary.test.js
// enforces it), so the same module runs in-process as the local host inside
// Electron's main process and as a standalone daemon on an SSH host
// (daemon.js).
import { startApiServer } from "../api/app.js";
import {
  getBrowserToolRelay,
  setBrowserToolRelay,
} from "../api/browser-bridge.js";
import { createTurnRegistry } from "../api/chat/turn-registry.js";
import { createHostSocket } from "../api/host-socket/host-socket.js";
import { createSocketTickets } from "../api/shared/socket-tickets.js";
import { resolveStateDatabasePath } from "../persisted-state.js";
import { createProcessSessionManager } from "../process-sessions.js";
import { createStateSaveQueue } from "../state-save-queue.js";
import { detectAvailableTerminalShells } from "../terminal-shells.js";
import { createHostCatalog } from "./catalog.js";
import { configureHostDataDirectory } from "./host-paths.js";
import { HOST_CAPABILITIES, HOST_PROTOCOL_VERSION } from "./protocol.js";

/**
 * @param {{
 *   dataDirectory: string,
 *   diagnosticsEnabled?: boolean,
 *   trackActivity?: boolean,
 *   version?: string | null,
 *   getStateWriter?: () => object,
 *   resolveRemoteHost?: (hostId: string) => { baseUrl: string, token: string } | null,
 * }} options
 *   `dataDirectory`: where the host keeps its files.
 *   `diagnosticsEnabled`: whether terminal flow-control diagnostics are served.
 *   `trackActivity`: count in-flight requests so `isBusy` sees them (a
 *   daemon's idle shutdown needs it; the local host does not).
 *   `version`: the app version this host was built from, for host-info.
 *   `getStateWriter`: the save queue catalog writes go through. The local
 *   host shares Electron main's (one writer per database file); without it
 *   the host starts its own.
 *   `resolveRemoteHost`: other hosts this one forwards requests to (the
 *   local host, for SSH-host projects); none on a daemon.
 */
export function createHost({
  dataDirectory,
  diagnosticsEnabled = false,
  trackActivity = false,
  version = null,
  getStateWriter,
  resolveRemoteHost,
}) {
  configureHostDataDirectory(dataDirectory);

  let ownWriter = null;
  const getWriter =
    getStateWriter ??
    (() =>
      (ownWriter ??= createStateSaveQueue({
        databasePath: resolveStateDatabasePath(),
      })));

  const hostSocket = createHostSocket();
  // Agents here use the browser of a window that has their project open
  // (the desktop app's own browser wins where there is one).
  setBrowserToolRelay(hostSocket.browser);
  const processSessions = createProcessSessionManager({
    emit: hostSocket.terminals.publish,
  });
  hostSocket.terminals.bindSessions(processSessions);
  const socketTickets = createSocketTickets();
  // Turns run on the host, detached from the requests that start them;
  // every client hears when one starts and ends.
  const turns = createTurnRegistry({
    onChange: ({ chatId, running }) =>
      hostSocket.catalog.publish({
        chatId,
        kind: "turn",
        origin: null,
        running,
      }),
  });
  const catalog = createHostCatalog({
    events: hostSocket.catalog,
    getRunningChatIds: turns.runningChatIds,
    getWriter,
  });

  let requestsInFlight = 0;
  const activity = trackActivity
    ? {
        begin: () => {
          requestsInFlight += 1;
        },
        end: () => {
          requestsInFlight = Math.max(0, requestsInFlight - 1);
        },
      }
    : undefined;

  const getHostInfo = () => ({
    arch: process.arch,
    capabilities: HOST_CAPABILITIES,
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    pid: process.pid,
    platform: process.platform,
    version,
  });

  let server = null;

  return {
    processSessions,
    /** The host catalog (projects, chats, transcripts). */
    catalog,
    getHostInfo,

    /** The host's running agent turns. */
    turns,

    /**
     * Whether anything is going on: a client on the host socket, a live
     * terminal, a running turn, or (with `trackActivity`) a request still
     * being answered.
     */
    isBusy: () =>
      hostSocket.getClientCount() > 0 ||
      processSessions.hasActiveSessions() ||
      turns.runningChatIds().length > 0 ||
      requestsInFlight > 0,

    /**
     * Starts serving the host's API on loopback.
     * @param {{ apiToken: string, port: number }} options
     *   `port` 0 picks a free port.
     * @returns {Promise<number>} the port it listens on
     */
    async listen({ apiToken, port }) {
      if (server) throw new Error("Host is already listening.");
      server = await startApiServer({
        activity,
        apiToken,
        catalog,
        getHostInfo,
        hostSocket: { socket: hostSocket, tickets: socketTickets },
        port,
        resolveRemoteHost,
        turns,
        terminals: {
          detectShells: detectAvailableTerminalShells,
          diagnosticsEnabled,
          sessions: processSessions,
        },
      });
      return server.port;
    },

    /**
     * Stops every terminal, closes the API server and flushes the host's
     * own state writer (a shared one is its owner's to flush).
     */
    async close() {
      turns.stopAll();
      if (getBrowserToolRelay() === hostSocket.browser) {
        setBrowserToolRelay(null);
      }
      await processSessions.stopAllProcesses();
      const closing = server;
      server = null;
      await closing?.close();
      await ownWriter?.flushAndClose();
    },
  };
}
