/**
 * Where a host's requests go and what credential they carry. Every request
 * the client makes to a host goes through here: the JSON routes, the chat
 * stream, raw file loads and the host socket's URL. Nothing patches
 * `window.fetch`, so a credential is attached only to that host's own
 * `/api/` paths, never to another URL, and a redirect is an error rather
 * than a request that carries it somewhere else.
 *
 *   desktop  `local`: this origin's API with the launch token. An SSH
 *            host: the same API's proxy, `/api/hosts/<id>/...`, which
 *            holds that host's own token in the main process.
 *   web      `local` (the paired host serving this page): this origin's
 *            API; the session cookie travels on its own (HttpOnly). Other
 *            hosts are not reachable from a browser yet (CONN-07).
 */
import { API_SESSION_TOKEN_HEADER } from "../api-session";
import { CLIENT_ID, CLIENT_ID_HEADER } from "../client-id";
import { hostApiPath, LOCAL_HOST_ID } from "../host-routing";
import { getClientPlatform } from "./platform";
import { connectionSupervisor } from "./runtime";

/** A host this client cannot reach on any route it has. */
export class HostUnreachableError extends Error {
  override name = "HostUnreachableError";
  constructor(readonly hostId: string) {
    super("This host can only be reached from the desktop app that added it.");
  }
}

export interface HostEndpoint {
  /** `path` (an `/api/...` route) as this client sends it to the host. */
  url(path: string): string;
  /** Headers every request to the host carries (its credential, the client id). */
  headers: Record<string, string>;
  credentials: RequestCredentials;
}

/** Where `hostId`'s requests go; throws HostUnreachableError. */
export const resolveHostEndpoint = (hostId: string): HostEndpoint => {
  const platform = getClientPlatform();
  const headers: Record<string, string> = { [CLIENT_ID_HEADER]: CLIENT_ID };
  if (platform.kind === "desktop") {
    const token = platform.desktop?.apiSessionToken;
    if (token) headers[API_SESSION_TOKEN_HEADER] = token;
    return {
      credentials: "same-origin",
      headers,
      url: (path) => hostApiPath(hostId, path),
    };
  }
  if (hostId !== LOCAL_HOST_ID) throw new HostUnreachableError(hostId);
  return { credentials: "same-origin", headers, url: (path) => path };
};

const assertApiPath = (path: string) => {
  if (!path.startsWith("/api/")) {
    throw new Error(`Not a host API path: ${path}`);
  }
};

const mergeHeaders = (base: Record<string, string>, extra?: HeadersInit) => {
  const headers = new Headers(extra);
  for (const [name, value] of Object.entries(base)) headers.set(name, value);
  return headers;
};

const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

/** Tells the supervisor what a response says about the host. */
export const reportHostResponse = (
  hostId: string,
  response: Response,
  reason = "",
) => {
  if (response.status === 401) {
    connectionSupervisor.report(
      hostId,
      "unauthorized",
      reason || "Pair this device with the host again.",
    );
  } else {
    connectionSupervisor.report(hostId, "ok", null);
  }
};

/**
 * A status a host may answer differently soon (a server error, a timeout,
 * too many requests): worth asking again, not a refusal.
 */
export const isTransientHostStatus = (status: number) =>
  status >= 500 || status === 408 || status === 429;

/**
 * Sends one request to `hostId` the way every request to a host goes: it
 * never follows a redirect (it carries the host's credential), and the
 * connection supervisor hears what the host answered, or that it could not
 * be reached. A request its caller aborted says nothing about the host.
 * `input` is already the host's URL (`hostFetch`, or the chat transport's
 * `hostRequestOptions`).
 */
export const fetchFromHost = async (
  hostId: string,
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetchImpl(input, { ...init, redirect: "error" });
  } catch (error) {
    if (!isAbort(error)) {
      connectionSupervisor.report(
        hostId,
        "unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  reportHostResponse(hostId, response);
  return response;
};

/**
 * `fetch` for one host's `/api/` path, with its credential. Reports the
 * outcome to the connection supervisor; a network failure rejects as
 * `fetch` does, after being reported.
 */
export const hostFetch = async (
  hostId: string,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Response> => {
  assertApiPath(path);
  const endpoint = resolveHostEndpoint(hostId);
  return fetchFromHost(
    hostId,
    endpoint.url(path),
    {
      ...init,
      credentials: endpoint.credentials,
      headers: mergeHeaders(endpoint.headers, init.headers),
    },
    fetchImpl,
  );
};

/**
 * What the AI SDK chat transport needs for one of `hostId`'s paths: its
 * URL, headers and credentials mode (the transport sends the request).
 */
export const hostRequestOptions = (hostId: string, path: string) => {
  assertApiPath(path);
  const endpoint = resolveHostEndpoint(hostId);
  return {
    api: endpoint.url(path),
    credentials: endpoint.credentials,
    headers: endpoint.headers,
  };
};

/** The WebSocket URL of one of `hostId`'s paths, with `query`. */
export const hostWebSocketUrl = (
  hostId: string,
  path: string,
  query: Record<string, string>,
) => {
  assertApiPath(path);
  const endpoint = resolveHostEndpoint(hostId);
  const url = new URL(endpoint.url(path), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url.href;
};
