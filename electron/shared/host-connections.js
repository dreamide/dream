// A client's saved connections: which persistent host each of its
// connection ids reaches, and the routes it reaches it by.
//
// Projects, workspace rows and request routing still name a host by the
// client's connection id: `local` for the host inside this app, an SSH
// host's id from Settings otherwise. A saved connection maps that id to the
// host's persistent identity (electron/host/identity.js) instead of every
// row being rewritten. A connection is saved the first time one of its
// routes is verified, by the descriptor listed with the host's catalog;
// until then (an SSH host that has not connected since this was added) it
// routes by its id alone, as before.
//
// Accepting a descriptor is the one rule for what a route may reach:
//   - the host it was saved for, or (unsaved) a host no other connection
//     already has, so one host never shows up twice;
//   - never another host: a changed route does not change its host. The
//     local route is the exception, being this app's own host by definition.
//
// The `local` connection id is the client's home host: the host inside the
// desktop app (route `local`), or, for a browser client, the paired host
// that serves its page (route `origin`). Only the first is exempt from
// pinning; an origin can be reassigned like any address.
// Matching ids are a consistency check, not authentication: the route
// (this app's own process, an authenticated SSH session) is what vouches
// for the host. Routes that cannot will verify the fingerprint's key.
// Explicit desktop additions merge authenticated identities before reaching
// this catalog guard. A public descriptor alone never authorizes that merge.
//
// Pure, and shared: the codec decodes saved connections with it.
import { hostProtocolProblem } from "../host/protocol.js";

/** @typedef {import("../../src/types/ide").SavedHostConnection} SavedHostConnection */
/** @typedef {import("../../src/types/ide").HostRoute} HostRoute */
/** @typedef {import("../../src/types/ide").HostDescriptor} HostDescriptor */

export const HOST_CONNECTION_RECORD_VERSION = 1;

/** The most routes one saved connection may have. */
export const MAX_HOST_ROUTES = 8;

/** The connection id of the host inside this app. */
const LOCAL_CONNECTION_ID = "local";

/** @param {unknown} value */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Saved connections as given, or none (a state that predates them).
 * @param {SavedHostConnection[] | undefined} connections
 */
const listOf = (connections) => (Array.isArray(connections) ? connections : []);

/** @param {unknown} value */
const nonEmpty = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * @param {unknown} value
 * @returns {HostRoute | null}
 */
const normalizeRoute = (value) => {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  if (!id) return null;
  if (value.kind === "local") return { id, kind: "local" };
  const origin = nonEmpty(value.origin);
  const credentialId = nonEmpty(value.credentialId);
  if (value.kind === "https" && origin && credentialId) {
    try {
      const url = new URL(origin);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.origin === origin
      )
        return { id, kind: "https", origin, credentialId };
    } catch {
      /* An invalid origin is never dialable. */
    }
    return null;
  }
  if (value.kind === "origin" && origin) return { id, kind: "origin", origin };
  const sshHostId = nonEmpty(value.sshHostId);
  if (value.kind === "ssh" && sshHostId) return { id, kind: "ssh", sshHostId };
  return null;
};

/**
 * Saved connections, repaired: each a known record version, with a
 * connection id and a host id no earlier record has.
 * @param {unknown} value
 * @returns {SavedHostConnection[]}
 */
export const normalizeHostConnections = (value) => {
  /** @type {SavedHostConnection[]} */
  const connections = [];
  const ids = new Set();
  const hostIds = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw)) continue;
    // A record a newer version wrote is not guessed at: its connection is
    // verified again as if new.
    if (
      (raw.version ?? HOST_CONNECTION_RECORD_VERSION) !==
      HOST_CONNECTION_RECORD_VERSION
    ) {
      continue;
    }
    const id = nonEmpty(raw.id);
    const hostId = nonEmpty(raw.hostId);
    if (!id || !hostId || ids.has(id) || hostIds.has(hostId)) continue;
    ids.add(id);
    hostIds.add(hostId);
    const routes = [];
    const routeIds = new Set();
    for (const rawRoute of Array.isArray(raw.routes) ? raw.routes : []) {
      const route = normalizeRoute(rawRoute);
      if (!route || routeIds.has(route.id)) continue;
      routeIds.add(route.id);
      routes.push(route);
    }
    connections.push({
      ...(nonEmpty(raw.label) ? { label: nonEmpty(raw.label) } : {}),
      fingerprint: nonEmpty(raw.fingerprint),
      hostId,
      id,
      routes,
      verifiedAt: nonEmpty(raw.verifiedAt),
      version: HOST_CONNECTION_RECORD_VERSION,
    });
  }
  return connections;
};

/** The desktop app's home route: its own host. */
export const LOCAL_ROUTE = Object.freeze({
  id: LOCAL_CONNECTION_ID,
  kind: "local",
});

/**
 * A browser client's home route: the paired host serving `origin`.
 * @param {string} origin
 * @returns {HostRoute}
 */
export const originRoute = (origin) => ({
  id: `origin:${origin}`,
  kind: "origin",
  origin,
});

/**
 * The route a connection id stands for today: the home host's route
 * (`homeRoute`, the desktop's own host unless told otherwise), or the SSH
 * host of that id in Settings.
 * @param {string} connectionId
 * @param {HostRoute} [homeRoute]
 * @returns {HostRoute}
 */
export const routeForConnectionId = (connectionId, homeRoute = LOCAL_ROUTE) =>
  connectionId === LOCAL_CONNECTION_ID
    ? homeRoute
    : { id: `ssh:${connectionId}`, kind: "ssh", sshHostId: connectionId };

/**
 * The saved connection for `connectionId`, if any.
 * @param {SavedHostConnection[]} connections
 * @param {string} connectionId
 */
export const findHostConnection = (connections, connectionId) =>
  listOf(connections).find((connection) => connection.id === connectionId) ??
  null;

/**
 * `connections` without `connectionId`'s (its host removed from Settings).
 * @param {SavedHostConnection[]} connections
 * @param {string} connectionId
 */
export const forgetHostConnection = (connections, connectionId) =>
  listOf(connections).some((connection) => connection.id === connectionId)
    ? listOf(connections).filter((connection) => connection.id !== connectionId)
    : connections;

/**
 * Whether the host that answered on `connectionId`'s route (its descriptor,
 * listed with its catalog) may be applied as that connection's host, and
 * the saved connections after accepting it. `connections` is returned as is
 * when nothing changed.
 * @param {SavedHostConnection[]} connections
 * @param {{
 *   connectionId: string,
 *   descriptor: unknown,
 *   labelOf: (connectionId: string) => string,
 *   homeRoute?: HostRoute,
 *   now?: () => string,
 * }} options
 *   `labelOf`: what the user calls a connection, for messages.
 *   `homeRoute`: how this client reaches its home host (`local`).
 * @returns {{ connections: SavedHostConnection[], error: string | null }}
 */
export const acceptHostDescriptor = (
  connections,
  {
    connectionId,
    descriptor,
    labelOf,
    homeRoute = LOCAL_ROUTE,
    now = () => new Date().toISOString(),
  },
) => {
  const refuse = (/** @type {string} */ error) => ({ connections, error });
  const host = isRecord(descriptor) ? descriptor : {};
  const saved = findHostConnection(connections, connectionId);
  const route =
    saved?.routes[0] ?? routeForConnectionId(connectionId, homeRoute);
  // This app's own host: recorded, never refused.
  const isLocal = route.kind === "local";

  // Before anything is read from it: a host this app cannot talk to.
  // An older host lists no descriptor at all, and speaks protocol 1.
  const protocol = isRecord(descriptor) ? host.hostProtocolVersion : 1;
  const problem = hostProtocolProblem(protocol);
  if (problem) return refuse(problem);

  const hostId = nonEmpty(host.hostId);
  const fingerprint = nonEmpty(host.fingerprint);
  if (!hostId) {
    // Too old to name itself: fine for a connection never verified, which
    // keeps routing by its id; not for one saved as a particular host.
    return saved && !isLocal
      ? refuse(
          route.kind === "origin"
            ? `“${labelOf(connectionId)}” did not identify itself, so it cannot be confirmed as the host this device paired with. Update the Dream host there.`
            : `“${labelOf(connectionId)}” did not identify itself, so it cannot be confirmed as the host saved for it. Update dream-host there.`,
        )
      : { connections, error: null };
  }

  if (saved) {
    const sameHost =
      saved.hostId === hostId &&
      (!saved.fingerprint || !fingerprint || saved.fingerprint === fingerprint);
    if (!sameHost && !isLocal) {
      return refuse(
        route.kind === "origin"
          ? `“${labelOf(connectionId)}” now serves a different Dream host than the one this device paired with, so its projects were not loaded. If that host was replaced, sign out and pair this device again.`
          : `“${labelOf(connectionId)}” now reaches a different Dream host than the one saved for it, so its projects were not loaded from there. If that machine was replaced, remove this host and add it again.`,
      );
    }
    if (
      sameHost &&
      (saved.fingerprint || !fingerprint) &&
      saved.routes.some((known) => known.id === route.id)
    ) {
      return { connections, error: null };
    }
  }

  const other = listOf(connections).find(
    (connection) =>
      connection.hostId === hostId && connection.id !== connectionId,
  );
  if (other && !isLocal) {
    return refuse(
      other.id === LOCAL_CONNECTION_ID
        ? `“${labelOf(connectionId)}” reaches the Dream host on this computer, which is already open here. Its projects were not loaded a second time.`
        : `“${labelOf(connectionId)}” reaches the same Dream host as “${labelOf(other.id)}”, which is already added. Its projects were not loaded a second time; use “${labelOf(other.id)}” or edit its SSH target instead.`,
    );
  }

  /** @type {SavedHostConnection} */
  const next =
    saved && saved.hostId === hostId
      ? {
          ...saved,
          fingerprint: saved.fingerprint ?? fingerprint,
          routes: saved.routes.some((known) => known.id === route.id)
            ? saved.routes
            : [...saved.routes, route],
        }
      : {
          fingerprint,
          hostId,
          id: connectionId,
          routes: [route],
          verifiedAt: now(),
          version: HOST_CONNECTION_RECORD_VERSION,
        };
  return {
    connections: [
      // The local host takes its id back from any connection that claimed
      // it; that one is refused the next time it is verified.
      ...listOf(connections).filter(
        (connection) =>
          connection.id !== connectionId && connection.hostId !== hostId,
      ),
      next,
    ],
    error: null,
  };
};

/** One choice per logical host, including unverified legacy SSH entries. */
export const listHostChoices = (connections, sshHosts) => {
  const claimed = new Set(
    listOf(connections).flatMap((host) =>
      host.routes.flatMap((route) =>
        route.kind === "ssh" ? [route.sshHostId] : [],
      ),
    ),
  );
  return [
    ...listOf(connections)
      .filter((host) => host.id !== LOCAL_CONNECTION_ID)
      .map((host) => {
        const ssh = host.routes.flatMap((route) =>
          route.kind === "ssh"
            ? sshHosts.filter((item) => item.id === route.sshHostId)
            : [],
        )[0];
        const direct = host.routes.find((route) => route.kind === "https");
        return {
          id: host.id,
          label: host.label ?? ssh?.label ?? direct?.origin ?? host.id,
          target: ssh?.target ?? "",
        };
      }),
    ...sshHosts.filter(
      (host) =>
        !claimed.has(host.id) &&
        !listOf(connections).some((saved) => saved.id === host.id),
    ),
  ];
};

/**
 * Projects and chats of an incoming host catalog whose ids another host in
 * this client already uses (a copied host data directory, say). Ids are
 * only unique within a host, and this client's state is keyed by them, so
 * such a catalog cannot be applied without mixing the two hosts up.
 * @param {{
 *   connectionId: string,
 *   catalog: { projects?: unknown, chats?: unknown },
 *   projects: { id: string, hostId?: string }[],
 *   chats: { id: string, projectId: string }[],
 * }} parts
 *   `projects` and `chats`: everything the client holds now, every host.
 * @returns {{ projectIds: string[], chatIds: string[] }}
 */
export const findCatalogIdCollisions = ({
  connectionId,
  catalog,
  projects,
  chats,
}) => {
  const hostOf = (/** @type {{ hostId?: string }} */ project) =>
    nonEmpty(project.hostId) ?? LOCAL_CONNECTION_ID;
  const otherProjectIds = new Set(
    projects
      .filter((project) => hostOf(project) !== connectionId)
      .map((project) => project.id),
  );
  const otherChatIds = new Set(
    chats
      .filter((chat) => otherProjectIds.has(chat.projectId))
      .map((chat) => chat.id),
  );
  const idsIn = (
    /** @type {unknown} */ list,
    /** @type {Set<string>} */ taken,
  ) =>
    (Array.isArray(list) ? list : [])
      .map((item) => (isRecord(item) ? item.id : null))
      .filter(
        /** @returns {id is string} */ (id) =>
          typeof id === "string" && taken.has(id),
      );
  return {
    chatIds: idsIn(catalog.chats, otherChatIds),
    projectIds: idsIn(catalog.projects, otherProjectIds),
  };
};
