// The desktop's route adapter. SSH launching, installation and prompts stay
// in ssh/. A logical connection owns selection and stable local port relays;
// closing a route ends its forward, never the host service or its work.
import net from "node:net";
import { API_SESSION_TOKEN_HEADER } from "../api/shared/session-token.js";
import { hostProtocolProblem } from "../host/protocol.js";
import { createRouteSupervisor } from "../shared/route-supervisor.js";
import { createSshHostManager } from "../ssh/ssh-hosts.js";

export function createDesktopHostConnections({
  onStatus = () => {},
  onPrompt,
  createSsh = createSshHostManager,
  fetchImpl = (...args) => fetch(...args),
  supervisorOptions = {},
  httpsRoutes = null,
  ...sshOptions
}) {
  const hosts = new Map();
  const attempts = new Map();
  let sequence = 0;
  const ssh = createSsh({
    ...sshOptions,
    onPrompt: (prompt) =>
      onPrompt({
        ...prompt,
        hostId: attempts.get(prompt.hostId)?.hostId ?? null,
      }),
    onStatus: (event) => {
      const attempt = attempts.get(event.hostId);
      if (
        attempt?.ready &&
        event.state !== "connected" &&
        event.state !== "connecting"
      ) {
        attempt.onLost(new Error(event.error ?? "The SSH route disconnected."));
      }
    },
  });

  const open = async (
    hostId,
    route,
    { signal, background, expectedIdentity, onLost },
  ) => {
    signal.throwIfAborted();
    if (route.kind === "https") {
      if (!httpsRoutes)
        throw Object.assign(new Error("HTTPS pairing is unavailable."), {
          fatal: true,
        });
      return httpsRoutes.open(route, { signal, expectedIdentity, onLost });
    }
    const key = `${hostId}:${++sequence}`;
    const attempt = { hostId, ready: false, onLost };
    attempts.set(key, attempt);
    const close = () => {
      signal.removeEventListener("abort", close);
      attempts.delete(key);
      ssh.disconnect(key);
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      const endpoint = await ssh.connect({
        autoReconnect: false,
        interactive: !background,
        signal,
        expectedIdentity,
        hostId: key,
        target: route.target,
      });
      signal.throwIfAborted();
      const response = await fetchImpl(`${endpoint.baseUrl}/api/catalog`, {
        method: "POST",
        headers: {
          [API_SESSION_TOKEN_HEADER]: endpoint.token,
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) {
        const reason = new Error(
          `The SSH route refused catalog access (${response.status}).`,
        );
        reason.fatal = response.status === 401 || response.status === 403;
        throw reason;
      }
      const catalog = await response.json();
      const problem = hostProtocolProblem(
        catalog.host?.hostProtocolVersion ?? endpoint.hostProtocolVersion,
      );
      if (problem) {
        const reason = new Error(problem);
        reason.fatal = true;
        throw reason;
      }
      if (
        endpoint.hostId &&
        (catalog.host?.hostId !== endpoint.hostId ||
          catalog.host?.fingerprint !== endpoint.fingerprint)
      ) {
        const reason = new Error(
          "The SSH route's catalog does not match its verified host identity.",
        );
        reason.fatal = true;
        throw reason;
      }
      signal.throwIfAborted();
      if (ssh.getState(key) !== "connected")
        throw new Error(
          "The SSH route disconnected before its catalog was ready.",
        );
      attempt.ready = true;
      return {
        endpoint: { ...endpoint, routeId: route.id },
        forwardPort: (port) => ssh.forwardPort(key, port),
        close,
      };
    } catch (reason) {
      close();
      throw reason;
    }
  };

  const forward = async (host, port) => {
    const selected = host.supervisor.getHandle();
    if (!selected) throw new Error("The host is not connected.");
    // Confirm the target can forward before reporting a stable local URL.
    if (!selected.forwardPort)
      throw new Error(
        "This route cannot forward arbitrary ports. Add an SSH route to view this site.",
      );
    await selected.forwardPort(port);
    if (host.closed || host.supervisor.getHandle() !== selected)
      throw new Error(
        "The route changed while forwarding the port. Try again.",
      );
    const server = net.createServer(async (client) => {
      host.sockets.add(client);
      client.on("error", () => {});
      client.once("close", () => host.sockets.delete(client));
      const handle = host.supervisor.getHandle();
      if (!handle) {
        client.destroy();
        return;
      }
      try {
        if (!handle.forwardPort)
          throw new Error("This route cannot forward ports.");
        const remotePort = await handle.forwardPort(port);
        if (
          client.destroyed ||
          host.closed ||
          handle !== host.supervisor.getHandle()
        ) {
          client.destroy();
          return;
        }
        const remote = net.connect(remotePort, "127.0.0.1");
        remote.on("error", () => client.destroy());
        remote.once("close", () => client.destroy());
        client.once("close", () => remote.destroy());
        client.pipe(remote).pipe(client);
      } catch {
        client.destroy();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (host.closed) {
      server.close();
      throw new Error("The host was disconnected.");
    }
    host.servers.add(server);
    return server.address().port;
  };

  const disconnect = (hostId) => {
    const host = hosts.get(hostId);
    if (!host) return;
    hosts.delete(hostId);
    host.closed = true;
    host.supervisor.disconnect();
    for (const socket of host.sockets) socket.destroy();
    for (const server of host.servers) server.close();
  };

  return {
    connect({
      hostId,
      target,
      expectedIdentity = null,
      sshRoutes,
      routes: configuredRoutes,
    }) {
      const routes = configuredRoutes ??
        sshRoutes ?? [{ id: `ssh:${hostId}`, target }];
      const config = JSON.stringify(routes);
      let host = hosts.get(hostId);
      if (
        host?.identity &&
        expectedIdentity &&
        (host.identity.hostId !== expectedIdentity.hostId ||
          (expectedIdentity.fingerprint &&
            host.identity.fingerprint !== expectedIdentity.fingerprint))
      ) {
        throw new Error(
          "This connection is pinned to a different host identity. Disconnect it before changing the saved host.",
        );
      }
      if (host && host.config !== config) {
        host.config = config;
        return host.supervisor
          .updateRoutes(routes)
          .then(() => host.supervisor.connect());
      }
      if (!host) {
        host = {
          config,
          identity: expectedIdentity,
          closed: false,
          sockets: new Set(),
          servers: new Set(),
          forwards: new Map(),
          routeId: null,
          supervisor: null,
        };
        const record = host;
        record.supervisor = createRouteSupervisor({
          ...supervisorOptions,
          routes,
          expectedIdentity,
          open: (route, options) => open(hostId, route, options),
          onStatus: (status) => {
            if (record.routeId !== status.routeId) {
              for (const socket of record.sockets) socket.destroy();
              record.routeId = status.routeId;
            }
            const endpoint = record.supervisor?.getEndpoint() ?? null;
            if (endpoint?.hostId)
              record.identity = {
                hostId: endpoint.hostId,
                fingerprint:
                  record.identity?.fingerprint ?? endpoint.fingerprint,
              };
            onStatus({ ...status, hostId, endpoint });
          },
        });
        hosts.set(hostId, record);
      }
      return host.supervisor.connect();
    },
    pairWithCode: (options) => httpsRoutes.pairWithCode(options),
    forgetCredential: (id) => httpsRoutes.forget(id),
    getEndpoint: (hostId) =>
      hosts.get(hostId)?.supervisor.getEndpoint() ?? null,
    getState: (hostId) =>
      hosts.get(hostId)?.supervisor.getState().state ?? "idle",
    getRouteState: (hostId) => hosts.get(hostId)?.supervisor.getState() ?? null,
    forwardPort(hostId, port) {
      const host = hosts.get(hostId);
      if (!host) return Promise.reject(new Error("The host is not connected."));
      let loading = host.forwards.get(port);
      if (!loading) {
        loading = forward(host, port).catch((reason) => {
          host.forwards.delete(port);
          throw reason;
        });
        host.forwards.set(port, loading);
      }
      return loading;
    },
    disconnect,
    async disconnectAll() {
      for (const hostId of hosts.keys()) disconnect(hostId);
      await ssh.disconnectAll();
    },
  };
}
