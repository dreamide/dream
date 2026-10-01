// The SSH hosts this app is connected to, one connection per target, and
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
 *   onPrompt: (prompt: { target: string, message: string, kind: string }) =>
 *     Promise<string | null>,
 *   onStatus?: (status: object) => void,
 *   sshPath?: string,
 *   multiplex?: boolean,
 * }} options
 *   `stateDirectory`: private folder for control sockets and the askpass
 *   wrapper (keep it short: socket paths are limited to ~100 characters).
 *   `multiplex`: use ControlMaster; OpenSSH on Windows cannot.
 */
export function createSshHostManager({
  stateDirectory,
  onPrompt,
  onStatus = () => {},
  sshPath = "ssh",
  multiplex = process.platform !== "win32",
}) {
  const connections = new Map();
  let askpass = null;
  // ssh does not say which connection a prompt belongs to; prompts are
  // asked one at a time, labelled with the target being connected.
  let promptingTarget = null;

  const getAskpass = async () => {
    askpass ??= startAskpassServer({
      directory: path.join(stateDirectory, "askpass"),
      onPrompt: (prompt) => onPrompt({ ...prompt, target: promptingTarget }),
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
     * Connects to `target` (an ~/.ssh/config alias or user@host).
     * @param {{ target: string, hostCommand?: string }} options
     */
    async connect({ target, hostCommand }) {
      const existing = connections.get(target);
      if (existing?.getState() === "connected") return existing.getEndpoint();
      existing?.disconnect();

      const { env } = await getAskpass();
      const connection = createSshHostConnection({
        controlPath: getControlPath(),
        env: { ...process.env, ...env },
        getLocalPort: () => getPort({ host: "127.0.0.1" }),
        hostCommand,
        onStatus,
        sshPath,
        target,
      });
      connections.set(target, connection);
      promptingTarget = target;
      try {
        return await connection.connect();
      } finally {
        if (promptingTarget === target) promptingTarget = null;
      }
    },

    getEndpoint: (target) => connections.get(target)?.getEndpoint() ?? null,

    disconnect(target) {
      connections.get(target)?.disconnect();
      connections.delete(target);
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
