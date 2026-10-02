/**
 * Which host a request is for, and where to send it.
 *
 * Every API request goes to the local API. A request for a project on an
 * SSH host goes to `/api/hosts/<hostId>/...`, which the local API forwards
 * over that host's connection (electron/api/host-proxy-routes.js). Callers
 * do not name the host: the request already names its project (by id, by
 * a chat of it, or by path), and the resolver the store registers maps that
 * to the project's host. A caller that does know (the catalog, per host)
 * says so explicitly.
 */

export const LOCAL_HOST_ID = "local";

/** What a request body may say about its project. */
export interface HostHint {
  projectId?: unknown;
  chatId?: unknown;
  projectPath?: unknown;
  sessionId?: unknown;
}

type HostResolver = (hint: HostHint) => string;

let resolver: HostResolver = () => LOCAL_HOST_ID;

/** The store registers how a hint maps to a host (ide-store.ts). */
export const setHostResolver = (next: HostResolver) => {
  resolver = next;
};

/** The host a request with this body is for; the local host by default. */
export const resolveRequestHost = (body: unknown): string => {
  if (!body || typeof body !== "object") return LOCAL_HOST_ID;
  try {
    return resolver(body as HostHint) || LOCAL_HOST_ID;
  } catch {
    return LOCAL_HOST_ID;
  }
};

/** `path` (an `/api/...` route) as sent for `hostId`. */
export const hostApiPath = (hostId: string, path: string): string =>
  hostId === LOCAL_HOST_ID || !path.startsWith("/api/")
    ? path
    : `/api/hosts/${encodeURIComponent(hostId)}/${path.slice("/api/".length)}`;
