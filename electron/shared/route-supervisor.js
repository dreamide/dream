// One logical host, several ordered routes. Transport adapters own credentials
// and identity proof; this owner selects only verified, ready handles. It
// never retries requests or knows how a host process is started or stopped.
import { MAX_HOST_ROUTES } from "./host-connections.js";

const RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/**
 * `open(route, {signal, background, expectedIdentity, onLost})` must verify
 * the host, authorization and readiness before returning a handle. A public
 * descriptor is not proof for an untrusted route. `background` is a probe
 * made while another route is serving, and must not prompt; recovering a
 * connection with no serving route may prompt, as its first connect did.
 * A handle supplies `endpoint` and idempotent `close()`, which detaches only
 * that transport. `onLost(error)` reports a later disconnect. Fatal failures
 * block that route until an explicit connect; cancellation stops the whole
 * attempt. Timers, time and jitter are injectable for every client.
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
    selected.handle.close();
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
    const candidate = { route, controller };
    attempt = candidate;
    emit();
    let selected = null;
    let lost = null;
    let timeout;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
      timeout = setTimer(
        () => controller.abort(new Error("Timed out connecting to the route.")),
        attemptTimeoutMs,
      );
    });
    // Even a transport that ignores cancellation cannot publish a late handle.
    const opening = Promise.resolve()
      .then(() =>
        open(route, {
          background,
          signal: controller.signal,
          expectedIdentity: pinned,
          onLost: (reason) => {
            lost = reason ?? new Error("The route disconnected.");
            if (selected) lose(selected, lost);
          },
        }),
      )
      .then((handle) => {
        if (controller.signal.aborted || !current(epoch)) {
          handle.close();
          throw new Error("Route attempt superseded.");
        }
        return handle;
      });
    let handle = null;
    try {
      handle = await Promise.race([opening, aborted]);
      if (lost) throw lost;
      const endpoint = handle.endpoint;
      if (
        pinned &&
        (endpoint.hostId !== pinned.hostId ||
          (pinned.fingerprint && endpoint.fingerprint !== pinned.fingerprint))
      ) {
        const refusal = new Error(
          "This route reaches a different host than the saved connection.",
        );
        refusal.fatal = true;
        throw refusal;
      }
      if (routes.length > 1 && (!endpoint.hostId || !endpoint.fingerprint)) {
        const refusal = new Error(
          "Multiple routes require a host with a persistent identity and key fingerprint.",
        );
        refusal.fatal = true;
        throw refusal;
      }
      if (!current(epoch)) throw new Error("Route attempt superseded.");
      if (endpoint.hostId)
        pinned = {
          hostId: endpoint.hostId,
          fingerprint: pinned?.fingerprint ?? endpoint.fingerprint,
        };
      const previous = active;
      selected = { route, handle };
      active = selected;
      wasReady = true;
      preferredAfter = now() + preferredCooldownMs;
      failures.delete(route.id);
      attempt = null;
      state = "connected";
      error = null;
      emit();
      previous?.handle.close();
      return handle.endpoint;
    } catch (reason) {
      handle?.close();
      controller.abort();
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
        if (active) return active.handle.endpoint;
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
    getEndpoint: () => active?.handle.endpoint ?? null,
    getHandle: () => active?.handle ?? null,
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
        previous.handle.close();
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
      if (active) return Promise.resolve(active.handle.endpoint);
      if (explicit) return explicit;
      const opened = session;
      const start = () => {
        if (opened !== session)
          throw new Error("Disconnected while connecting.");
        if (active) return active.handle.endpoint;
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
      previous?.handle.close();
      state = "disconnected";
      error = null;
      emit();
    },
  };
}
