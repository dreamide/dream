// The SSH hosts this app is connected to, one connection per host id, and
// what they share: the askpass server their prompts go through and the
// private folder for ControlMaster sockets.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import getPort from "get-port";
import { startAskpassServer } from "./askpass-server.js";
import {
  createSshHostConnection,
  SshHostError,
} from "./ssh-host-connection.js";

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
  const controlNamespace = randomUUID();
  let askpass = null;
  // ssh does not say which connection a prompt belongs to; prompts are
  // asked one at a time, labelled with the host being connected.
  let prompting = null;

  // A declined prompt (cancelled, or left unanswered) ends the attempt.
  // ssh reads a failed askpass as an empty password and asks again, up to
  // NumberOfPasswordPrompts times; cancel has to mean cancel.
  const askFor = async (prompt) => {
    const asking = prompting;
    if (asking?.cancelled) return null;
    const answer = await onPrompt({
      ...prompt,
      hostId: asking?.hostId ?? null,
      target: asking?.target ?? null,
    });
    if (answer === null && asking && !asking.cancelled) {
      asking.cancelled = true;
      asking.connection.cancel("Cancelled at the SSH prompt.");
    }
    return answer;
  };

  const getAskpass = async () => {
    askpass ??= startAskpassServer({
      directory: path.join(stateDirectory, "askpass"),
      onPrompt: askFor,
    });
    return askpass;
  };

  const getControlPath = (hostId, target) => {
    if (!multiplex) return null;
    const directory = path.join(stateDirectory, "cm");
    mkdirSync(directory, { mode: 0o700, recursive: true });
    // A preferred probe and its healthy fallback may resolve to the same
    // machine, so %C (host, port and user) would alias their masters. One
    // short name per connection instead: ssh adds a 17-character suffix
    // while binding, and socket paths are limited to ~104 characters.
    return path.join(
      directory,
      createHash("sha256")
        .update(`${controlNamespace}\0${hostId}\0${target}`)
        .digest("hex")
        .slice(0, 16),
    );
  };

  return {
    /**
     * Connects host `hostId` at `target` (an ~/.ssh/config alias or
     * user@host). `hostId` is the app's name for the host, which requests
     * are routed by; it defaults to the target. `expectedIdentity` is the
     * persistent host the app saved for it: no other host is connected.
     * @param {{
     *   hostId?: string,
     *   target: string,
     *   hostCommand?: string,
     *   expectedIdentity?: { hostId: string, fingerprint?: string | null } | null,
     *   signal?: AbortSignal,
     *   autoReconnect?: boolean,
     *   interactive?: boolean,
     * }} options
     */
    async connect({
      hostId: requestedHostId,
      target,
      hostCommand,
      expectedIdentity = null,
      signal,
      autoReconnect = true,
      interactive = true,
    }) {
      signal?.throwIfAborted();
      const hostId = requestedHostId ?? target;
      const existing = connections.get(hostId);
      if (existing?.getState() === "connected") {
        const endpoint = existing.getEndpoint();
        if (
          !expectedIdentity?.hostId ||
          (endpoint?.hostId === expectedIdentity.hostId &&
            (!expectedIdentity.fingerprint ||
              endpoint?.fingerprint === expectedIdentity.fingerprint))
        ) {
          return endpoint;
        }
        throw new SshHostError(
          `${target} is connected to a different Dream host than the one saved for it.`,
          { fatal: true },
        );
      }
      existing?.disconnect();

      const { env } = await getAskpass();
      signal?.throwIfAborted();
      const connection = createSshHostConnection({
        autoReconnect,
        interactive,
        controlPath: getControlPath(hostId, target),
        // A silent probe keeps askpass forced but without its secret, so the
        // helper declines at once. A prompt from a hop BatchMode does not
        // reach (ProxyJump) cannot be shown under a foreground host's name.
        env: {
          ...process.env,
          ...env,
          ...(interactive ? {} : { DREAM_ASKPASS_SECRET: "" }),
        },
        expectedIdentity,
        getLocalPort: () => getPort({ host: "127.0.0.1" }),
        hostCommand: hostCommand || null,
        runtimeCacheDirectory: path.join(stateDirectory, "runtime"),
        runtimeVersion,
        onStatus: (status) => onStatus({ ...status, hostId }),
        sshPath,
        target,
      });
      connections.set(hostId, connection);
      const asking = { cancelled: false, connection, hostId, target };
      // Silent preferred probes cannot take ownership of a foreground
      // connection's password/host-key prompt.
      if (interactive) prompting = asking;
      const cancel = () => {
        connection.cancel();
        connection.disconnect();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await connection.connect();
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (prompting === asking) prompting = null;
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
