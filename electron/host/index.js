// The host: everything a project needs from the machine it lives on (its
// files, the agent CLIs, terminals, git and the state database) behind one
// HTTP + WebSocket API. Nothing here imports Electron (host-boundary.test.js
// enforces it), so the same module runs in-process as the local host inside
// Electron's main process and as a standalone daemon on an SSH host
// (daemon.js).
import os from "node:os";
import path from "node:path";
import { startApiServer } from "../api/app.js";
import {
  getBrowserToolRelay,
  setBrowserToolRelay,
} from "../api/browser-bridge.js";
import { stopCodexAppServer } from "../api/chat/codex-app-server-client.js";
import { createDelegationService } from "../api/chat/delegation.js";
import { createRunScheduler } from "../api/chat/run-scheduler.js";
import { createTurnRegistry } from "../api/chat/turn-registry.js";
import { executeChatRequest } from "../api/chat-routes.js";
import { createHostSocket } from "../api/host-socket/host-socket.js";
import { startRemoteApiServer } from "../api/remote-app.js";
import { createSocketTickets } from "../api/shared/socket-tickets.js";
import {
  awaitingApprovalChatIds,
  onToolApprovalsChange,
} from "../api/tool-approvals.js";
import { resolveStateDatabasePath } from "../persisted-state.js";
import { createProcessSessionManager } from "../process-sessions.js";
import { createStateReadPool } from "../state-read-pool.js";
import { createStateSaveQueue } from "../state-save-queue.js";
import { detectAvailableTerminalShells } from "../terminal-shells.js";
import { createHostAuth } from "./auth/host-auth.js";
import { createHostCatalog } from "./catalog.js";
import { configureHostDataDirectory } from "./host-paths.js";
import { createHostProofSigner, loadHostIdentity } from "./identity.js";
import { HOST_CAPABILITIES, HOST_PROTOCOL_VERSION } from "./protocol.js";
import { createRemoteAccess } from "./remote-access/remote-access.js";
import { createTailscale } from "./remote-access/tailscale.js";
import { describeHostSettings } from "./settings-report.js";
import { acquireStateLock } from "./state-lock.js";

/**
 * @param {{
 *   dataDirectory: string,
 *   diagnosticsEnabled?: boolean,
 *   trackActivity?: boolean,
 *   version?: string | null,
 *   getStateWriter?: () => object,
 *   resolveRemoteHost?: (hostId: string) => { baseUrl: string, token: string } | null,
 *   clientDirectory?: string | null,
 *   tailscale?: ReturnType<typeof createTailscale>,
 *   kind?: string,
 *   onShutdownRequest?: (reason: string) => void,
 *   lockDetails?: Record<string, unknown>,
 *   owner?: "user" | "desktop" | null,
 *   remoteOverride?: Parameters<typeof createRemoteAccess>[0]["override"],
 * }} options
 *   `lockDetails`: more for the state lock's record (a daemon's run
 *   directory and owner), so a desktop can find a host on its database.
 *   `owner`: who started the host (`--owner`), reported by POST
 *   /api/host/settings; a host in a desktop's process is the desktop's.
 *   `remoteOverride`: remote access set when the host started.
 *   `dataDirectory`: where the host keeps its files.
 *   `diagnosticsEnabled`: whether terminal flow-control diagnostics are served.
 *   `trackActivity`: count in-flight requests so `isBusy` sees them (a
 *   daemon's idle shutdown needs it; the local host does not).
 *   `version`: the app version this host was built from, for host-info.
 *   `getStateWriter`: the save queue catalog writes go through. The local
 *   host shares Electron main's (one writer per database file); without it
 *   the host starts its own. A shared one needs every host write the save
 *   queue has: applyCatalogChanges, mutateRunQueue, ready,
 *   saveChatMessages, saveProviderSession and writeDeviceSession. Catalog reads go through the host's own read
 *   pool, which opens the file once the writer is `ready`.
 *   `resolveRemoteHost`: other hosts this one forwards requests to (the
 *   local host, for SSH-host projects); none on a daemon.
 *   `clientDirectory`: the browser client paired devices load (the
 *   renderer build); its remote listener serves it.
 *   `tailscale`: the Tailscale adapter remote access uses (the real CLI by
 *   default).
 *   `kind`: what runs this host (`desktop`, `daemon`), named in its state
 *   lock so a second host can say who has the data.
 *   `onShutdownRequest`: a daemon's own shutdown, asked for over the local
 *   API (`POST /api/host/shutdown`, the launch token's holder only): a
 *   clean stop that flushes writes, where a signal cannot (Windows).
 *
 * Throws StateLockedError (state-lock.js) when another process already runs
 * a host on the same state database.
 */
export function createHost({
  dataDirectory,
  diagnosticsEnabled = false,
  trackActivity = false,
  version = null,
  getStateWriter,
  resolveRemoteHost,
  clientDirectory = null,
  tailscale = createTailscale(),
  kind = "host",
  onShutdownRequest,
  lockDetails = {},
  owner = null,
  remoteOverride = null,
}) {
  configureHostDataDirectory(dataDirectory);
  const databasePath = resolveStateDatabasePath();
  // One host per state database: its catalog has one writer.
  const releaseStateLock = acquireStateLock(databasePath, {
    details: lockDetails,
    kind,
  });
  const startedAt = new Date().toISOString();
  // Before anything else: a host that cannot say who it is serves nobody.
  const identity = loadHostIdentity(dataDirectory);
  const signHostProof = createHostProofSigner(dataDirectory);

  let ownWriter = null;
  const getWriter =
    getStateWriter ??
    (() =>
      (ownWriter ??= createStateSaveQueue({
        databasePath,
      })));

  let readPool = null;
  const getReader = () =>
    (readPool ??= createStateReadPool({
      databasePath,
      whenReady: () => getWriter().ready(),
    }));

  // Paired devices' sessions, for the remote listener and the management
  // routes on the local one (auth/host-auth.js).
  const auth = createHostAuth({ getReader, getWriter });

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
    onChange: ({ chatId, running }) => {
      hostSocket.catalog.publish({
        chatId,
        kind: "turn",
        origin: null,
        running,
      });
      if (!running) scheduler.dispatch(chatId);
    },
  });
  const catalog = createHostCatalog({
    events: hostSocket.catalog,
    getAwaitingApprovalChatIds: awaitingApprovalChatIds,
    getReader,
    getRunningChatIds: turns.streamingChatIds,
    getWriter,
  });
  // A chat waiting on its user is news to every client, open or not.
  const stopApprovalEvents = onToolApprovalsChange(({ awaiting, chatId }) =>
    hostSocket.catalog.publish({
      awaiting,
      chatId,
      kind: "approval",
      origin: null,
    }),
  );
  const scheduler = createRunScheduler({
    catalog,
    turns,
    execute: executeChatRequest,
  });
  const delegation = createDelegationService({ catalog, scheduler });
  scheduler.setDelegation(delegation);

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

  // Who this host is and what it speaks: nothing about where its files
  // are, and no credential. Clients check it before applying a catalog.
  const getHostDescriptor = () => ({
    capabilities: HOST_CAPABILITIES,
    fingerprint: identity.fingerprint,
    hostId: identity.hostId,
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    publicKey: identity.publicKey,
    version,
  });

  const getHostInfo = () => ({
    ...getHostDescriptor(),
    arch: process.arch,
    pid: process.pid,
    platform: process.platform,
  });

  let server = null;
  let remoteServer = null;

  /** What POST /api/host/settings reports: who this host is. */
  const getHostSettings = () =>
    describeHostSettings({
      access: remoteAccess.status(),
      descriptor: getHostDescriptor(),
      owner: owner ?? (kind === "desktop" ? "desktop" : "user"),
      localPort: server?.port ?? null,
      name: os.hostname(),
      pid: process.pid,
      startedAt,
      version,
    });
  /** What both listeners serve, besides their own guards. */
  // Whether and how paired devices reach this host; the listener it starts
  // is this host's remote listener (below).
  const remoteAccess = createRemoteAccess({
    close: async () => {
      const closing = remoteServer;
      remoteServer = null;
      await closing?.close();
    },
    dataDirectory,
    // Keep existing default-host settings; custom databases (such as dev.db)
    // save their own ports and Serve ownership instead of sharing that file.
    settingsFile:
      path.basename(databasePath) === "dream.db"
        ? path.join(path.dirname(databasePath), "remote-access.json")
        : `${databasePath}.remote-access.json`,
    hostId: () => identity.hostId,
    hostIdentity: getHostDescriptor,
    override: remoteOverride,
    listen: async (options) => {
      if (!server) throw new Error("Start the host's local listener first.");
      if (remoteServer) await remoteServer.close();
      remoteServer = null;
      remoteServer = await startRemoteApiServer(services(), {
        clientDirectory,
        ...options,
      });
      return { origins: remoteServer.origins, port: remoteServer.port };
    },
    tailscale,
  });

  const services = () => ({
    signHostProof,
    activity,
    auth,
    onShutdownRequest,
    remoteAccess,
    catalog,
    delegation,
    getHostDescriptor,
    getHostInfo,
    getHostSettings,
    hostSocket: { socket: hostSocket, tickets: socketTickets },
    scheduler,
    terminals: {
      detectShells: detectAvailableTerminalShells,
      diagnosticsEnabled,
      sessions: processSessions,
    },
    turns,
  });

  return {
    processSessions,
    /** The host catalog (projects, chats, transcripts). */
    catalog,
    getHostDescriptor,
    getHostInfo,

    /** The host's running agent turns. */
    turns,

    /**
     * Whether anything is going on: a client on the host socket, a live
     * terminal, a running turn, or (with `trackActivity`) a request still
     * being answered.
     */
    isBusy: () =>
      // Remote access on: paired devices may arrive at any time.
      remoteAccess.status().enabled ||
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
      await scheduler.initialize();
      // Paired devices' sessions; local work never waits on them. A failed
      // load is tried again by the next remote request, which fails closed.
      await auth.load().catch((error) => {
        console.warn("Unable to load device sessions.", error);
      });
      server = await startApiServer({
        ...services(),
        apiToken,
        publicOrigins: () => remoteServer?.origins ?? [],
        port,
        resolveRemoteHost,
      });
      return server.port;
    },

    /**
     * Starts serving paired devices (api/remote-app.js), after `listen`.
     * Bound to loopback unless told otherwise: a reverse proxy (Tailscale
     * Serve) is what exposes it, and pairing is required whoever reaches it.
     * @param {{
     *   port: number,
     *   hostname?: string,
     *   publicOrigins?: string[],
     *   trustForwardedHost?: boolean,
     * }} options
     *   `publicOrigins`: the origins clients load from (the HTTPS URL the
     *   proxy serves). `trustForwardedHost`: the proxy names the host in
     *   X-Forwarded-Host.
     * @returns {Promise<{ port: number, origins: string[] }>}
     */
    async listenRemote(options) {
      if (!server) throw new Error("Start the host's local listener first.");
      if (remoteServer) throw new Error("The remote listener is running.");
      remoteServer = await startRemoteApiServer(services(), {
        clientDirectory,
        ...options,
      });
      return { origins: remoteServer.origins, port: remoteServer.port };
    },

    /**
     * Remote access as configured (host/remote-access/): call after
     * `listen`, once. Starts the remote listener when access is on.
     */
    startRemoteAccess: () => remoteAccess.start(),

    /** Remote access: status, enable, disable, refresh. */
    remoteAccess,

    /** Stops serving paired devices; local work carries on. */
    async closeRemote() {
      const closing = remoteServer;
      remoteServer = null;
      await closing?.close();
    },

    /**
     * Stops every terminal, closes the API server and its state readers,
     * and flushes the host's own state writer (a shared one is its owner's
     * to flush).
     */
    async close() {
      stopApprovalEvents();
      await scheduler.close();
      // Codex turns run through one app server per process: the host's.
      await stopCodexAppServer().catch((error) =>
        console.warn("Could not stop the Codex app server.", error),
      );
      if (getBrowserToolRelay() === hostSocket.browser) {
        setBrowserToolRelay(null);
      }
      await processSessions.stopAllProcesses();
      await remoteAccess.close();
      const closingRemote = remoteServer;
      remoteServer = null;
      await closingRemote?.close();
      const closing = server;
      server = null;
      await closing?.close();
      // Closed for good: a read after this (a stopped turn's last save)
      // is refused rather than starting new reader threads.
      await readPool?.close();
      await ownWriter?.flushAndClose();
      releaseStateLock();
    },
  };
}
