// The desktop's logical host connections: one route supervisor per host
// over the SSH and paired HTTPS route adapters, and the stable local port
// relays its forwards are reached by. Closing a route ends its forward,
// never the host service or its work.
import net from "node:net";
import { matchesPinnedIdentity } from "../shared/host-verification.js";
import { createRouteSupervisor } from "../shared/route-supervisor.js";
import { createSshRoutes } from "./ssh-route.js";

export function createDesktopHostConnections({
  onStatus = () => {},
  onPrompt,
  createSsh,
  fetchImpl,
  supervisorOptions = {},
  httpsRoutes = null,
  ...sshOptions
}) {
  const hosts = new Map();
  const ssh = createSshRoutes({
    ...sshOptions,
    // Undefined takes the adapter's own defaults.
    createSsh,
    fetchImpl,
    onPrompt,
  });

  /** @type {(hostId: string) => import("../shared/route-supervisor.js").RouteAdapter} */
  const adapterFor = (hostId) => (route, options) => {
    if (route.kind !== "https") return ssh.open(hostId, route, options);
    if (!httpsRoutes)
      throw Object.assign(new Error("HTTPS pairing is unavailable."), {
        fatal: true,
      });
    return httpsRoutes.open(route, options);
  };

  const forward = async (host, port) => {
    const selected = host.supervisor.getLink();
    if (!selected) throw new Error("The host is not connected.");
    // Confirm the target can forward before reporting a stable local URL.
    if (!selected.forwardPort)
      throw new Error(
        "This route cannot forward arbitrary ports. Add an SSH route to view this site.",
      );
    await selected.forwardPort(port);
    if (host.closed || host.supervisor.getLink() !== selected)
      throw new Error(
        "The route changed while forwarding the port. Try again.",
      );
    const server = net.createServer(async (client) => {
      host.sockets.add(client);
      client.on("error", () => {});
      client.once("close", () => host.sockets.delete(client));
      const link = host.supervisor.getLink();
      if (!link) {
        client.destroy();
        return;
      }
      try {
        if (!link.forwardPort)
          throw new Error("This route cannot forward ports.");
        const remotePort = await link.forwardPort(port);
        if (
          client.destroyed ||
          host.closed ||
          link !== host.supervisor.getLink()
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
    /**
     * Connects `hostId` over its routes to dial, checked by
     * `readConnectRequest` (shared/routes-to-dial.js).
     * @param {import("../../src/types/ide").HostConnectRequest} request
     */
    connect({ hostId, routes, expectedIdentity = null }) {
      const config = JSON.stringify(routes);
      let host = hosts.get(hostId);
      const pinned = host?.supervisor.getPinnedIdentity();
      if (
        pinned &&
        expectedIdentity &&
        !matchesPinnedIdentity(expectedIdentity, pinned)
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
          open: adapterFor(hostId),
          onStatus: (status) => {
            if (record.routeId !== status.routeId) {
              for (const socket of record.sockets) socket.destroy();
              record.routeId = status.routeId;
            }
            onStatus({
              ...status,
              hostId,
              endpoint: record.supervisor?.getEndpoint() ?? null,
            });
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
