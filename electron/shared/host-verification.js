// Whether the host a route reached is the host a connection expects. Every
// route adapter, the route supervisor, the SSH modules, the desktop's home
// host attachment and saved host connections ask these questions here;
// each keeps its own refusal wording and decides when to ask (a refusal
// before a device credential is sent stays before it).
//
// Pure apart from the probes, which take the fetch to use: the renderer
// checks a host descriptor with this module too, so no Node built-ins.
import { SUPPORTED_HOST_PROTOCOLS } from "../host/protocol.js";

/**
 * @typedef {{ hostId: string, fingerprint?: string | null }} PinnedIdentity
 * @typedef {{ hostId?: string | null, fingerprint?: string | null }} ReportedIdentity
 */

/** How long a host has to say who it is. */
export const HOST_INFO_TIMEOUT_MS = 2_000;

/** How long a route has to list a catalog before it is used. */
export const CATALOG_PROBE_TIMEOUT_MS = 15_000;

/**
 * Whether a host that reports `reported` is the pinned host: the same host
 * ID and, when a fingerprint is pinned, the same fingerprint. A host that
 * reports no fingerprint does not match a pinned one. Callers decide
 * whether anything is pinned yet.
 * @param {PinnedIdentity} pinned
 * @param {ReportedIdentity | null | undefined} reported
 * @returns {boolean}
 */
export function matchesPinnedIdentity(pinned, reported) {
  return (
    reported?.hostId === pinned.hostId &&
    (!pinned.fingerprint || reported?.fingerprint === pinned.fingerprint)
  );
}

/**
 * Why this app cannot talk to a host speaking `version`, as something the
 * user can act on, or null when it can.
 * @param {unknown} version
 * @returns {string | null}
 */
export function hostProtocolProblem(version) {
  const supported =
    SUPPORTED_HOST_PROTOCOLS.min === SUPPORTED_HOST_PROTOCOLS.max
      ? `${SUPPORTED_HOST_PROTOCOLS.min}`
      : `${SUPPORTED_HOST_PROTOCOLS.min}–${SUPPORTED_HOST_PROTOCOLS.max}`;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return "The host did not say which protocol it speaks. Update dream-host there.";
  }
  if (version > SUPPORTED_HOST_PROTOCOLS.max) {
    return `The host speaks protocol ${version}, newer than this app supports (${supported}). Update Dream on this computer.`;
  }
  if (version < SUPPORTED_HOST_PROTOCOLS.min) {
    return `The host speaks protocol ${version}, older than this app supports (${supported}). Update dream-host there.`;
  }
  return null;
}

/**
 * Whether a catalog lists exactly the host its route just verified: the
 * same host ID and fingerprint, not merely a compatible one.
 * @param {{ host?: ReportedIdentity | null } | null | undefined} catalog
 * @param {ReportedIdentity} verified
 * @returns {boolean}
 */
export function catalogMatchesHost(catalog, verified) {
  return (
    catalog?.host?.hostId === verified.hostId &&
    catalog?.host?.fingerprint === verified.fingerprint
  );
}

/**
 * Asks the host at `baseUrl` who it is (`GET /api/host-info`). Resolves
 * with the response, whatever its status; rejects as `fetchImpl` does.
 * `headers` carries the caller's credential. Redirects are refused.
 * @param {{
 *   baseUrl: string,
 *   headers: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<Response>}
 */
export function requestHostInfo({
  baseUrl,
  headers,
  fetchImpl = (...args) => fetch(...args),
}) {
  return fetchImpl(`${baseUrl}/api/host-info`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(HOST_INFO_TIMEOUT_MS),
  });
}

/**
 * Lists the catalog at `baseUrl` (`POST /api/catalog`), so a route can
 * check it names the verified host before the route is used. Resolves with
 * the response, whatever its status. `headers` carries the credential.
 * @param {{
 *   baseUrl: string,
 *   headers?: Record<string, string>,
 *   signal: AbortSignal,
 *   fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
 * }} options
 * @returns {Promise<Response>}
 */
export function requestCatalogProbe({
  baseUrl,
  headers = {},
  signal,
  fetchImpl,
}) {
  return fetchImpl(`${baseUrl}/api/catalog`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(CATALOG_PROBE_TIMEOUT_MS),
    ]),
  });
}
