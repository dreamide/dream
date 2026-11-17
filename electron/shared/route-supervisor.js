// One logical host, several ordered routes. A route adapter opens one link
// over one route and reports it lost; this owner makes every link ready the
// same way (Host verification's readiness sequence and one rule for what is
// fatal), pins the host, selects among ready links and retries. It never
// retries requests or knows how a host process is started or stopped.
import { MAX_HOST_ROUTES } from "./host-connections.js";
import {
  catalogMatchesHost,
  hostProtocolProblem,
  matchesPinnedIdentity,
  requestCatalogProbe,
} from "./host-verification.js";

const RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/**
 * What a link reached: the host's descriptor (`hostId`, `fingerprint`,
 * `hostProtocolVersion`, `version`) and how to reach it (`baseUrl`, plus the
 * transport's own fields: an SSH `token`, an HTTPS `fetch` and
 * `socketOptions`). The supervisor adds the `routeId`.
 * @typedef {{
 *   baseUrl: string,
 *   hostId?: string | null,
 *   fingerprint?: string | null,
 *   hostProtocolVersion?: number,
 *   version?: string | null,
 *   routeId?: string,
 *   [field: string]: unknown,
 * }} RouteEndpoint
 */

/**
 * One link a route adapter opened over one route. Opening stops at the
 * transport: the SSH session and its forward, or the HTTPS transport that
 * checks each socket's host proof. Readiness is the supervisor's.
 * @typedef {{
 *   endpoint: RouteEndpoint,
 *   request: (url: string, init: RequestInit) => Promise<Response>,
 *   authorize?: (signal: AbortSignal) => Promise<Response>,
 *   forwardPort?: (remotePort: number) => Promise<number>,
 *   close: () => void,
 * }} RouteLink
 *   `endpoint` is read after `authorize` (an HTTPS link learns its host
 *   from its first verified socket, so it may be a getter).
 *   `request` is a fetch that carries the link's credential.
 *   `authorize` shows the host this desktop's credential and answers with
 *   the host's response (HTTPS renews its device session); absent where
 *   opening already proved it (an SSH link's token came from the host).
 *   `forwardPort` forwards a port of the host here, when the transport can.
 *   `close` is idempotent and detaches only this transport.
 */

/**
 * A route adapter. `open(route, {signal, background, expectedIdentity,
 * onLost})` resolves with one link or rejects with why; `fatal` on the
 * error marks a refusal retrying cannot change (authentication, a host
 * key, a certificate), `cancelled` one the user made. `expectedIdentity`
 * is the connection's pinned host, for a transport that refuses before
 * sending a credential. `background` is a probe made while another route
 * is serving, and must not prompt; recovering a connection with no serving
 * route may prompt, as its first connect did. `onLost(error)` reports that
 * the link went away, at any time after `open` was called. An adapter never
 * reconnects: the supervisor dials again.
 * @typedef {(
 *   route: { id: string, [field: string]: unknown },
 *   options: {
 *     signal: AbortSignal,
 *     background: boolean,
 *     expectedIdentity: { hostId: string, fingerprint?: string | null } | null,
 *     onLost: (error?: Error) => void,
 *   },
 * ) => Promise<RouteLink>} RouteAdapter
 */

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

/**
 * The one rule for a host's refusal: 401 or 403 means the credential is
 * refused, which retrying cannot change until an explicit connect; any
 * other status may pass. Used for authorization, the catalog probe and an
 * HTTPS link's later session checks alike.
 * @param {string} what
 * @param {number} status
 */
export function routeRefusal(what, status) {
  return Object.assign(new Error(`${what} (${status}).`), {
    fatal: status === 401 || status === 403,
    status,
  });
}

/**
 * Host verification's readiness sequence for a link, the same for every
 * route: authorize; the pinned host (and, beside other routes, a
 * persistent identity); the catalog probe; the protocol check; the catalog
 * naming the host the link reached. Resolves with the link's endpoint.
 * @param {RouteLink} link
 * @param {{
 *   signal: AbortSignal,
 *   pinned: { hostId: string, fingerprint?: string | null } | null,
 *   needsIdentity: boolean,
 * }} options
 * @returns {Promise<RouteEndpoint>}
 */
export async function readyLink(link, { signal, pinned, needsIdentity }) {
  if (link.authorize) {
    const response = await link.authorize(signal);
    await response.body?.cancel();
    if (!response.ok)
      throw routeRefusal("The route refused access", response.status);
  }
  signal.throwIfAborted();
  const endpoint = link.endpoint;
  if (pinned && !matchesPinnedIdentity(pinned, endpoint))
    throw fatal(
      "This route reaches a different host than the saved connection.",
    );
  if (needsIdentity && (!endpoint.hostId || !endpoint.fingerprint))
    throw fatal(
      "Multiple routes require a host with a persistent identity and key fingerprint.",
    );
  const response = await requestCatalogProbe({
    baseUrl: endpoint.baseUrl,
    signal,
    fetchImpl: link.request,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw routeRefusal("The route refused catalog access", response.status);
  }
  const catalog = await response.json();
  const problem = hostProtocolProblem(
    catalog?.host?.hostProtocolVersion ?? endpoint.hostProtocolVersion,
  );
  if (problem) throw fatal(problem);
  if (endpoint.hostId && !catalogMatchesHost(catalog, endpoint))
    throw fatal("The route's catalog does not match its verified host.");
  signal.throwIfAborted();
  return endpoint;
}

/**
 * Supervises one connection's ordered routes over `open`, a route adapter.
 * Each attempt opens a link and makes it ready with `readyLink`; only a
 * ready link is selected. A lost or failed route cools down with jittered
 * backoff; a fatal failure blocks that route until an explicit connect;
 * cancellation stops the whole attempt. The first host reached (or
 * `expectedIdentity`) is pinned for the connection's life. Timers, time
 * and jitter are injectable for every client.
 * @param {{
 *   routes: Array<{ id: string, [field: string]: unknown }>,
 *   open: RouteAdapter,
 *   expectedIdentity?: { hostId: string, fingerprint?: string | null } | null,
 *   onStatus?: (status: object) => void,
 *   now?: () => number,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: any) => void,
 *   random?: () => number,
 *   attemptTimeoutMs?: number,
 *   preferredCooldownMs?: number,
 * }} options
 */
export function createRouteSupervisor({
  routes,
  open,
  expectedIdentity = null,
  onStatus = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  attemptTimeoutMs = 5 * 60_000,
  preferredCooldownMs = 30_000,
}) {
  if (
    !routes.length ||
    new Set(routes.map((route) => route.id)).size !== routes.length
  ) {
    throw new Error("A connection needs distinct routes in preference order.");
  }
  const failures = new Map();
  let pinned = expectedIdentity;
  let active = null;
  let attempt = null;
  let pending = null;
  let explicit = null;
  let session = 0;
  let timer = null;
  let generation = 0;
  let stopped = true;
  let wasReady = false;
  let preferredAfter = 0;
  let state = "idle";
  let error = null;
  let lastStatus = null;

  const snapshot = () => ({
    state,
    error,
    routeId: active?.route.id ?? null,
    routes: routes.map((route) => ({
      routeId: route.id,
      state:
        active?.route.id === route.id
          ? "ready"
          : attempt?.route.id === route.id
            ? "connecting"
            : failures.get(route.id)?.blocked
              ? "blocked"
              : failures.has(route.id)
                ? "cooldown"
                : "idle",
      error: failures.get(route.id)?.error ?? null,
      retryAt: failures.get(route.id)?.retryAt ?? null,
    })),
  });
  const emit = () => {
    const status = snapshot();
    const serialized = JSON.stringify(status);
    if (serialized === lastStatus) return;
    lastStatus = serialized;
    onStatus(status);
  };
  const clearWake = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const current = (epoch) => !stopped && epoch === generation;

  const fail = (route, reason) => {
    const previous = failures.get(route.id);
    const count = (previous?.count ?? 0) + 1;
    failures.set(route.id, {
      count,
      blocked: Boolean(reason.fatal),
      error: reason.message || String(reason),
      retryAt: reason.fatal
        ? null
        : now() +
          Math.round(
            RETRY_MS[Math.min(count - 1, RETRY_MS.length - 1)] *
              (0.8 + random() * 0.4),
          ),
    });
  };

  const eligible = () => {
    const limit = active
      ? routes.findIndex((route) => route.id === active.route.id)
      : routes.length;
    if (active && now() < preferredAfter) return [];
    return routes.slice(0, limit).filter((route) => {
      const failure = failures.get(route.id);
      return !failure?.blocked && (failure?.retryAt ?? 0) <= now();
    });
  };

  const schedule = () => {
    clearWake();
    if (stopped || !wasReady) return;
    const limit = active
      ? routes.findIndex((route) => route.id === active.route.id)
      : routes.length;
    const times = routes.slice(0, limit).flatMap((route) => {
      const failure = failures.get(route.id);
      return failure?.blocked
        ? []
        : [Math.max(failure?.retryAt ?? now(), active ? preferredAfter : 0)];
    });
    if (!times.length) return;
    timer = setTimer(
      () => {
        timer = null;
        void drive().catch(() => {});
      },
      Math.max(1, Math.min(...times) - now()),
    );
  };

  const lose = (selected, reason = new Error("The route disconnected.")) => {
    if (active !== selected || stopped) return;
    active = null;
    selected.link.close();
    fail(selected.route, reason);
    state = "reconnecting";
    error = reason.message;
    // A background probe belongs to the old selection. Discard it before
    // starting fallback, including a late readiness response from that probe.
    generation += 1;
    attempt?.controller.abort();
    attempt = null;
    pending = null;
    emit();
    void drive().catch(() => {});
  };

  const dial = async (route, epoch) => {
    // Only a probe beside a serving route is silent. Recovery with nothing
    // serving may prompt again, as the connection's first attempt could.
    const background = active !== null;
    const controller = new AbortController();
    const { signal } = controller;
    const candidate = { route, controller };
    attempt = candidate;
    emit();
    let selected = null;
    let link = null;
    let timeout;
    const aborted = new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      timeout = setTimer(
        () => controller.abort(new Error("Timed out connecting to the route.")),
        attemptTimeoutMs,
      );
    });
    // Even a transport that ignores cancellation cannot publish a late link.
    const opening = Promise.resolve()
      .then(() =>
        open(route, {
          background,
          signal,
          expectedIdentity: pinned,
          // Lost before it was selected, the attempt fails with the reason.
          onLost: (reason = new Error("The route disconnected.")) => {
            if (selected) lose(selected, reason);
            else controller.abort(reason);
          },
        }),
      )
      .then(async (opened) => {
        if (signal.aborted || !current(epoch)) {
          opened.close();
          throw new Error("Route attempt superseded.");
        }
        link = opened;
        return readyLink(opened, {
          signal,
          pinned,
          needsIdentity: routes.length > 1,
        });
      });
    try {
      const endpoint = await Promise.race([opening, aborted]);
      if (!current(epoch)) throw new Error("Route attempt superseded.");
      if (endpoint.hostId)
        pinned = {
          hostId: endpoint.hostId,
          fingerprint: pinned?.fingerprint ?? endpoint.fingerprint ?? null,
        };
      const previous = active;
      selected = { route, link, endpoint: { ...endpoint, routeId: route.id } };
      active = selected;
      wasReady = true;
      preferredAfter = now() + preferredCooldownMs;
      failures.delete(route.id);
      attempt = null;
      state = "connected";
      error = null;
      emit();
      previous?.link.close();
      return selected.endpoint;
    } catch (reason) {
      // A late link from a transport that ignored the abort closes itself
      // above; one already opened closes here.
      opening.catch(() => {});
      controller.abort(reason);
      link?.close();
      throw reason;
    } finally {
      clearTimer(timeout);
      if (attempt === candidate) attempt = null;
    }
  };

  function drive() {
    if (pending) return pending;
    clearWake();
    const epoch = generation;
    const work = Promise.resolve()
      .then(async () => {
        for (const route of eligible()) {
          if (!current(epoch)) break;
          try {
            return await dial(route, epoch);
          } catch (reason) {
            if (!current(epoch))
              throw stopped && !reason?.cancelled
                ? new Error("Disconnected while connecting.")
                : reason;
            if (reason.cancelled) {
              stopped = true;
              state = "failed";
              error = reason.message;
              emit();
              throw reason;
            }
            fail(route, reason);
            if (!active) error = reason.message;
            emit();
          }
        }
        if (active) return active.endpoint;
        if (current(epoch)) {
          state =
            wasReady &&
            [...failures.values()].some((failure) => !failure.blocked)
              ? "reconnecting"
              : "failed";
          emit();
        }
        throw new Error(error ?? "No route is available for this host.");
      })
      .finally(() => {
        if (pending === work) {
          pending = null;
          schedule();
        }
      });
    pending = work;
    return work;
  }

  return {
    getState: snapshot,
    getEndpoint: () => active?.endpoint ?? null,
    /** The selected link, for transport services such as port forwards. */
    getLink: () => active?.link ?? null,
    /** The host this connection is pinned to, once known. */
    getPinnedIdentity: () => pinned,
    updateRoutes(next) {
      if (
        !next.length ||
        next.length > MAX_HOST_ROUTES ||
        new Set(next.map((route) => route.id)).size !== next.length
      )
        throw new Error(
          `A connection needs between 1 and ${MAX_HOST_ROUTES} distinct routes.`,
        );
      generation += 1;
      attempt?.controller.abort();
      attempt = null;
      pending = null;
      explicit = null;
      clearWake();
      const unchanged = (route) =>
        next.some((item) => JSON.stringify(item) === JSON.stringify(route));
      for (const route of routes)
        if (!unchanged(route)) failures.delete(route.id);
      routes = next;
      if (active && !unchanged(active.route)) {
        const previous = active;
        active = null;
        previous.link.close();
      }
      if (!stopped) {
        preferredAfter = 0;
        state = active ? "connected" : "reconnecting";
        emit();
        return drive();
      }
      emit();
      return Promise.resolve(null);
    },
    connect() {
      if (active) return Promise.resolve(active.endpoint);
      if (explicit) return explicit;
      const opened = session;
      const start = () => {
        if (opened !== session)
          throw new Error("Disconnected while connecting.");
        if (active) return active.endpoint;
        stopped = false;
        failures.clear();
        state = wasReady ? "reconnecting" : "connecting";
        error = null;
        emit();
        return drive();
      };
      // A recovery attempt already running settles first; this request then
      // retries every route, including blocked and cooling ones.
      const run = pending ? pending.then(start, start) : start();
      const tracked = run.finally(() => {
        if (explicit === tracked) explicit = null;
      });
      explicit = tracked;
      return tracked;
    },
    disconnect() {
      stopped = true;
      session += 1;
      explicit = null;
      generation += 1;
      clearWake();
      attempt?.controller.abort();
      attempt = null;
      pending = null;
      const previous = active;
      active = null;
      previous?.link.close();
      state = "disconnected";
      error = null;
      emit();
    },
  };
}
