// What connecting a saved host dials. A Saved host connection names each SSH
// route by its SSH host in Settings (`sshHostId`); this module is the one
// place that reads such a route against those settings, and it states the
// one shape the desktop bridge carries to the main process: the routes to
// dial, in preference order, and the host they are pinned to. The renderer
// resolves a connection into it; the main process checks it once, here,
// before the route supervisor dials it.
//
// An SSH host from Settings that has never connected has no saved
// connection: its connection id is its SSH host id, and it dials the one
// SSH route that id stands for.
//
// Pure, and shared by the renderer and the main process.

/** @typedef {import("../../src/types/ide").HostRoute} HostRoute */
/** @typedef {import("../../src/types/ide").SavedHostConnection} SavedHostConnection */
/** @typedef {import("../../src/types/ide").SshHostConfig} SshHostConfig */
/** @typedef {import("../../src/types/ide").DialRoute} DialRoute */
/** @typedef {import("../../src/types/ide").HostConnectRequest} HostConnectRequest */

/** The most routes one saved connection may have. */
export const MAX_HOST_ROUTES = 8;

/**
 * The SSH route an SSH host in Settings stands for.
 * @param {string} sshHostId
 * @returns {HostRoute}
 */
export const sshRouteFor = (sshHostId) => ({
  id: `ssh:${sshHostId}`,
  kind: "ssh",
  sshHostId,
});

/**
 * The routes of connection `connectionId`: its saved routes, or (never
 * saved) the SSH route its id stands for.
 * @param {SavedHostConnection | null | undefined} saved
 * @param {string} connectionId
 * @returns {HostRoute[]}
 */
export const connectionRoutes = (saved, connectionId) =>
  saved?.routes ?? [sshRouteFor(connectionId)];

/**
 * The SSH host in Settings that `route` goes through; null for a route
 * that is not SSH, or whose SSH host is no longer in Settings.
 * @param {HostRoute} route
 * @param {readonly SshHostConfig[]} sshHosts
 * @returns {SshHostConfig | null}
 */
export const sshHostOf = (route, sshHosts) =>
  route.kind === "ssh"
    ? (sshHosts.find((host) => host.id === route.sshHostId) ?? null)
    : null;

/**
 * The saved connection that reaches SSH host `sshHostId` (from Settings)
 * by one of its routes, or null.
 * @param {readonly SavedHostConnection[] | undefined} connections
 * @param {string} sshHostId
 * @returns {SavedHostConnection | null}
 */
export const connectionOfSshHost = (connections, sshHostId) =>
  (connections ?? []).find((connection) =>
    connection.routes.some(
      (route) => route.kind === "ssh" && route.sshHostId === sshHostId,
    ),
  ) ?? null;

/**
 * What connecting `connectionId` dials: its routes in preference order,
 * each SSH route with its target from Settings, and the host it is pinned
 * to once saved. Routes the desktop does not dial (its own host, a page's
 * origin) and SSH routes whose host left Settings are left out, so the
 * routes can be empty.
 * @param {{
 *   connectionId: string,
 *   saved: SavedHostConnection | null | undefined,
 *   sshHosts: readonly SshHostConfig[],
 * }} parts
 * @returns {HostConnectRequest}
 */
export const routesToDial = ({ connectionId, saved, sshHosts }) => ({
  hostId: connectionId,
  routes: connectionRoutes(saved, connectionId).flatMap((route) => {
    if (route.kind === "https")
      return [
        {
          id: route.id,
          kind: /** @type {const} */ ("https"),
          origin: route.origin,
          credentialId: route.credentialId,
        },
      ];
    const ssh = sshHostOf(route, sshHosts);
    return ssh
      ? [
          {
            id: route.id,
            kind: /** @type {const} */ ("ssh"),
            target: ssh.target,
          },
        ]
      : [];
  }),
  expectedIdentity: saved
    ? { hostId: saved.hostId, fingerprint: saved.fingerprint ?? null }
    : null,
});

/** @param {unknown} value */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value */
const nonEmpty = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * An id as given, when it is one: ids name rows on both sides of the
 * bridge, so they are never rewritten.
 * @param {unknown} value
 */
const idOf = (value) =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * @param {unknown} value
 * @returns {DialRoute}
 */
const readRoute = (value) => {
  const route = isRecord(value) ? value : {};
  const id = idOf(route.id);
  if (!id) throw new Error("A route needs an id.");
  const target = nonEmpty(route.target);
  if (route.kind === "ssh" && target) return { id, kind: "ssh", target };
  const origin = nonEmpty(route.origin);
  const credentialId = nonEmpty(route.credentialId);
  if (route.kind === "https" && origin && credentialId)
    return { id, kind: "https", origin, credentialId };
  throw new Error("Each route needs an SSH target or paired HTTPS origin.");
};

/**
 * A connect request as it arrived over the desktop bridge, checked: a
 * connection id, between one and MAX_HOST_ROUTES routes with distinct ids,
 * and the pinned host or null. Only the fields of the shape are kept, and
 * targets and origins trimmed. Throws why it is not one.
 * @param {unknown} payload
 * @returns {HostConnectRequest}
 */
export const readConnectRequest = (payload) => {
  const request = isRecord(payload) ? payload : {};
  const hostId = idOf(request.hostId);
  if (!hostId) throw new Error("A connection needs an id.");
  const { routes, expectedIdentity } = request;
  if (
    !Array.isArray(routes) ||
    !routes.length ||
    routes.length > MAX_HOST_ROUTES
  )
    throw new Error(
      `A connection needs between 1 and ${MAX_HOST_ROUTES} routes.`,
    );
  const read = routes.map(readRoute);
  if (new Set(read.map((route) => route.id)).size !== read.length)
    throw new Error("Route ids must be distinct.");
  if (expectedIdentity === null || expectedIdentity === undefined)
    return { hostId, routes: read, expectedIdentity: null };
  const pinned = isRecord(expectedIdentity) ? expectedIdentity : {};
  const pinnedHostId = idOf(pinned.hostId);
  if (
    !pinnedHostId ||
    (pinned.fingerprint !== null && typeof pinned.fingerprint !== "string")
  )
    throw new Error("An expected host needs an id and a fingerprint or null.");
  return {
    hostId,
    routes: read,
    expectedIdentity: {
      hostId: pinnedHostId,
      fingerprint: /** @type {string | null} */ (pinned.fingerprint),
    },
  };
};
