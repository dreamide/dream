// The SSH hosts this app is connected to, one connection per host id, and
// what they share: the askpass server their prompts go through and the
// private folder for ControlMaster sockets.
import { mkdirSync } from "node:fs";
import path from "node:path";
import getPort from "get-port";
import { startAskpassServer } from "./askpass-server.js";
import { createSshHostConnection } from "./ssh-host-connection.js";

/**
 * @param {{
 *   stateDirectory: string,
 *   onPrompt: (prompt: { hostId: string | null, target: string | null, message: string, kind: string }) =>
 *     Promise<string | null>,
 *   onStatus?: (status: object) => void,
 *   sshPath?: string,
 *   multiplex?: boolean,
 *   runtimeVersion?: string | null,
 * }} options
 *   `stateDirectory`: private folder for control sockets and the askpass
 *   wrapper (keep it short: socket paths are limited to ~100 characters).
 *   `multiplex`: use ControlMaster; OpenSSH on Windows cannot.
 *   `runtimeVersion`: the host runtime a host without its own host command
 *   gets installed (this app's version).
 */
export function createSshHostManager({
  stateDirectory,
  onPrompt,
  onStatus = () => {},
  sshPath = "ssh",
  multiplex = process.platform !== "win32",
  runtimeVersion = null,
}) {
  const connections = new Map();
  let askpass = null;
  // ssh does not say which connection a prompt belongs to; prompts are
  // asked one at a time, labelled with the host being connected.
  let prompting = null;

  const getAskpass = async () => {
    askpass ??= startAskpassServer({
      directory: path.join(stateDirectory, "askpass"),
      onPrompt: (prompt) =>
        onPrompt({
          ...prompt,
          hostId: prompting?.hostId ?? null,
          target: prompting?.target ?? null,
        }),
    });
    return askpass;
  };

  const getControlPath = () => {
    if (!multiplex) return null;
    const directory = path.join(stateDirectory, "cm");
    mkdirSync(directory, { mode: 0o700, recursive: true });
    // %C: a hash of host, port and user, expanded by ssh.
    return path.join(directory, "%C");
  };

  return {
    /**
     * Connects host `hostId` at `target` (an ~/.ssh/config alias or
     * user@host). `hostId` is the app's name for the host, which requests
     * are routed by; it defaults to the target.
     * @param {{ hostId?: string, target: string, hostCommand?: string }} options
     */
    async connect({ hostId: requestedHostId, target, hostCommand }) {
      const hostId = requestedHostId ?? target;
      const existing = connections.get(hostId);
      if (existing?.getState() === "connected") return existing.getEndpoint();
      existing?.disconnect();

      const { env } = await getAskpass();
      const connection = createSshHostConnection({
        controlPath: getControlPath(),
        env: { ...process.env, ...env },
        getLocalPort: () => getPort({ host: "127.0.0.1" }),
        hostCommand: hostCommand || null,
        runtimeCacheDirectory: path.join(stateDirectory, "runtime"),
        runtimeVersion,
        onStatus: (status) => onStatus({ ...status, hostId }),
        sshPath,
        target,
      });
      connections.set(hostId, connection);
      prompting = { hostId, target };
      try {
        return await connection.connect();
      } finally {
        if (prompting?.hostId === hostId) prompting = null;
      }
    },

    getEndpoint: (hostId) => connections.get(hostId)?.getEndpoint() ?? null,

    getState: (hostId) => connections.get(hostId)?.getState() ?? "idle",

    /** Forwards host `hostId`'s `port` here; resolves with the local port. */
    forwardPort: async (hostId, port) => {
      const connection = connections.get(hostId);
      if (!connection) throw new Error("The host is not connected.");
      return connection.forwardPort(port);
    },

    disconnect(hostId) {
      connections.get(hostId)?.disconnect();
      connections.delete(hostId);
    },

    /** Ends every session (on quit). Daemons keep running. */
    async disconnectAll() {
      for (const connection of connections.values()) connection.disconnect();
      connections.clear();
      const closing = askpass;
      askpass = null;
      await (await closing)?.close();
    },
  };
}
