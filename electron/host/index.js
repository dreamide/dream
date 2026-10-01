// The host: everything a project needs from the machine it lives on (its
// files, the agent CLIs, terminals, git and the state database) behind one
// HTTP + WebSocket API. Nothing here imports Electron (host-boundary.test.js
// enforces it), so the same module runs in-process as the local host inside
// Electron's main process and as a standalone daemon on an SSH host
// (daemon.js).
import { startApiServer } from "../api/app.js";
import { createHostSocket } from "../api/host-socket/host-socket.js";
import { createSocketTickets } from "../api/shared/socket-tickets.js";
import { createProcessSessionManager } from "../process-sessions.js";
import { detectAvailableTerminalShells } from "../terminal-shells.js";
import { configureHostDataDirectory } from "./host-paths.js";
import { HOST_CAPABILITIES, HOST_PROTOCOL_VERSION } from "./protocol.js";

/**
 * @param {{
 *   dataDirectory: string,
 *   diagnosticsEnabled?: boolean,
 *   trackActivity?: boolean,
 *   version?: string | null,
 * }} options
 *   `dataDirectory`: where the host keeps its files.
 *   `diagnosticsEnabled`: whether terminal flow-control diagnostics are served.
 *   `trackActivity`: count in-flight requests so `isBusy` sees them (a
 *   daemon's idle shutdown needs it; the local host does not).
 *   `version`: the app version this host was built from, for host-info.
 */
export function createHost({
  dataDirectory,
  diagnosticsEnabled = false,
  trackActivity = false,
  version = null,
}) {
  configureHostDataDirectory(dataDirectory);

  const hostSocket = createHostSocket();
  const processSessions = createProcessSessionManager({
    emit: hostSocket.terminals.publish,
  });
  hostSocket.terminals.bindSessions(processSessions);
  const socketTickets = createSocketTickets();

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
    /** Where host catalog changes are published for every client. */
    catalogEvents: hostSocket.catalog,
    getHostInfo,

    /**
     * Whether anything is going on: a client on the host socket, a live
     * terminal, or (with `trackActivity`) a request still being answered.
     */
    isBusy: () =>
      hostSocket.getClientCount() > 0 ||
      processSessions.hasActiveSessions() ||
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
        getHostInfo,
        hostSocket: { socket: hostSocket, tickets: socketTickets },
        port,
        terminals: {
          detectShells: detectAvailableTerminalShells,
          diagnosticsEnabled,
          sessions: processSessions,
        },
      });
      return server.port;
    },

    /** Stops every terminal and closes the API server. */
    async close() {
      await processSessions.stopAllProcesses();
      const closing = server;
      server = null;
      await closing?.close();
    },
  };
}
