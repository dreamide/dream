// The SSH route adapter: one link to a host's daemon over one SSH route,
// for the route supervisor. SSH launching, installation and prompts stay in
// ssh/; readiness, retry and pinning are the supervisor's. Closing a link
// ends its session and forwards, never the host service or its work.
import { API_SESSION_TOKEN_HEADER } from "../api/shared/session-token.js";
import { createSshHostManager } from "../ssh/ssh-hosts.js";

/**
 * @param {{
 *   onPrompt: (prompt: object) => Promise<string | null>,
 *   createSsh?: typeof createSshHostManager,
 *   fetchImpl?: typeof fetch,
 *   [sshOption: string]: unknown,
 * }} options
 *   `onPrompt` gets each SSH prompt under the connection's host id.
 *   Everything else is the SSH host manager's (`stateDirectory`,
 *   `runtimeVersion`, `sshPath`, ...).
 */
export function createSshRoutes({
  onPrompt,
  createSsh = createSshHostManager,
  fetchImpl = (...args) => fetch(...args),
  ...sshOptions
}) {
  // Each link is its own SSH connection, under a key of its own, so an
  // attempt's prompts and statuses never answer for another attempt's.
  const links = new Map();
  let sequence = 0;
  const ssh = createSsh({
    ...sshOptions,
    onPrompt: (prompt) =>
      onPrompt({
        ...prompt,
        hostId: links.get(prompt.hostId)?.hostId ?? null,
      }),
    onStatus: (event) => {
      const link = links.get(event.hostId);
      if (
        link?.opened &&
        event.state !== "connected" &&
        event.state !== "connecting"
      ) {
        link.onLost(new Error(event.error ?? "The SSH route disconnected."));
      }
    },
  });

  return {
    /**
     * Opens one link for connection `hostId` over `route` (`{ id, target }`).
     * @type {(
     *   hostId: string,
     *   route: { id: string, target: string },
     *   options: { signal: AbortSignal, background: boolean, onLost: (error: Error) => void },
     * ) => Promise<import("../shared/route-supervisor.js").RouteLink>}
     */
    async open(hostId, route, { signal, background, onLost }) {
      signal.throwIfAborted();
      const key = `${hostId}:${++sequence}`;
      const link = { hostId, opened: false, onLost };
      links.set(key, link);
      const close = () => {
        signal.removeEventListener("abort", close);
        links.delete(key);
        ssh.disconnect(key);
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        const endpoint = await ssh.connect({
          interactive: !background,
          signal,
          hostId: key,
          target: route.target,
        });
        signal.throwIfAborted();
        if (ssh.getState(key) !== "connected")
          throw new Error("The SSH route disconnected while connecting.");
        link.opened = true;
        // The daemon's token came from the host over SSH: the link is
        // already authorized, and every request carries it.
        return {
          endpoint,
          request: (url, init = {}) =>
            fetchImpl(url, {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init.headers)),
                [API_SESSION_TOKEN_HEADER]: endpoint.token,
              },
            }),
          forwardPort: (port) => ssh.forwardPort(key, port),
          close,
        };
      } catch (reason) {
        close();
        throw reason;
      }
    },
    disconnectAll: () => ssh.disconnectAll(),
  };
}
