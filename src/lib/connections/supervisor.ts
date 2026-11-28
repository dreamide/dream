/**
 * One connection supervisor per client: the state of its connection to
 * each host, and the lifecycle signals (foregrounding, coming back online)
 * that tell the host sockets, catalogs and streams to check theirs.
 *
 * Connection state is about the transport and the credential only:
 *
 *   connecting     a first attempt is under way
 *   ready          requests reach the host and are authorized
 *   reconnecting   it was ready; the host is unreachable for now
 *   unauthorized   the host refused this client's credential (revoked,
 *                  expired, never paired): retrying will not help
 *   incompatible   the host is not one this client may use (another host,
 *                  a protocol it does not speak): retrying will not help
 *   offline        not reachable, and not known to have been ready
 *
 * Whether the host's catalog is loaded is separate (the store's catalog
 * lifecycle, store/host-catalog-lifecycle.ts): a ready connection can still
 * be loading its catalog.
 *
 * Who decides a host's state depends on its route. A browser client's
 * home host is judged by its own requests (`report`). A desktop SSH host
 * is judged by the main process, which owns the ssh session (`set`, from
 * its status events); requests through the desktop's proxy do not
 * override that.
 *
 * Pure apart from the lifecycle port, which is injected.
 */

export type ConnectionStatus =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "unauthorized"
  | "incompatible"
  | "offline";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Why it is not ready, for the user. */
  error: string | null;
  /** When it entered this status. */
  since: number;
}

const OFFLINE_CONNECTION_STATE: ConnectionState = Object.freeze({
  error: null,
  since: 0,
  status: "offline",
});

/** What one request found out about its host. */
export type RequestOutcome = "ok" | "unauthorized" | "unreachable";

/** Lifecycle signals from the platform (a page, a native app). */
export interface LifecycleSignals {
  /** The client came back to the foreground after `hiddenMs` away. */
  onForeground(listener: (hiddenMs: number) => void): () => void;
  /** The device's network came back. */
  onOnline(listener: () => void): () => void;
}

export interface ResumeEvent {
  /** `foreground` after being hidden; `online` after a network change. */
  reason: "foreground" | "online";
  hiddenMs: number;
}

/** States a request outcome cannot change: retrying will not help. */
const TERMINAL: ReadonlySet<ConnectionStatus> = new Set([
  "unauthorized",
  "incompatible",
]);

export const createConnectionSupervisor = ({
  now = () => Date.now(),
}: {
  now?: () => number;
} = {}) => {
  const states = new Map<string, ConnectionState>();
  /** Hosts whose state their own requests decide. */
  const judgedByRequests = new Set<string>();
  const listeners = new Set<(hostId: string, state: ConnectionState) => void>();
  const resumeListeners = new Set<(event: ResumeEvent) => void>();

  const set = (
    hostId: string,
    status: ConnectionStatus,
    error: string | null = null,
  ) => {
    const previous = states.get(hostId);
    if (previous?.status === status && previous.error === error) return;
    const next = { error, since: now(), status };
    states.set(hostId, next);
    for (const listener of listeners) listener(hostId, next);
  };

  const resume = (event: ResumeEvent) => {
    for (const listener of resumeListeners) listener(event);
  };

  return {
    /** The host's state; `offline` for one never seen. */
    get: (hostId: string): ConnectionState =>
      states.get(hostId) ?? OFFLINE_CONNECTION_STATE,

    /** Calls `listener` with each change; returns its removal. */
    subscribe(listener: (hostId: string, state: ConnectionState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Sets a host's state from its route's owner (a status event). */
    set,

    /**
     * Has `hostId`'s state follow its own requests from now on, starting
     * at `connecting`.
     */
    judgeByRequests(hostId: string) {
      judgedByRequests.add(hostId);
      if (!states.has(hostId)) set(hostId, "connecting");
    },

    /** What a request to `hostId` found; ignored unless judged by requests. */
    report(hostId: string, outcome: RequestOutcome, error: string | null) {
      if (!judgedByRequests.has(hostId)) return;
      const current = states.get(hostId)?.status ?? "connecting";
      if (outcome === "ok") {
        // A host that refused this client stays refused until a new
        // credential or route is in place (clear), however many of its
        // public requests succeed.
        if (!TERMINAL.has(current)) set(hostId, "ready");
        return;
      }
      if (outcome === "unauthorized") {
        set(hostId, "unauthorized", error);
        return;
      }
      if (TERMINAL.has(current)) return;
      set(
        hostId,
        current === "ready" || current === "reconnecting"
          ? "reconnecting"
          : "offline",
        error,
      );
    },

    /** A refused state no longer applies (re-paired, route changed). */
    clear(hostId: string) {
      const current = states.get(hostId)?.status;
      if (current && TERMINAL.has(current)) set(hostId, "connecting");
    },

    /** The connection was removed: its state goes with it. */
    forget(hostId: string) {
      judgedByRequests.delete(hostId);
      states.delete(hostId);
    },

    /**
     * Calls `listener` when the client should check its connections
     * (foregrounded, back online); returns its removal.
     */
    onResume(listener: (event: ResumeEvent) => void) {
      resumeListeners.add(listener);
      return () => {
        resumeListeners.delete(listener);
      };
    },

    /** Starts following the platform's lifecycle; returns the stop. */
    follow(signals: LifecycleSignals) {
      const stops = [
        signals.onForeground((hiddenMs) =>
          resume({ hiddenMs, reason: "foreground" }),
        ),
        signals.onOnline(() => resume({ hiddenMs: 0, reason: "online" })),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },

    /** Resumes now, as a lifecycle signal would (and for tools). */
    resume,
  };
};

export type ConnectionSupervisor = ReturnType<
  typeof createConnectionSupervisor
>;

/**
 * A page's lifecycle: visible again (or restored from the back/forward
 * cache) and back online. A desktop window has the same events (minimized
 * and restored), where the checks are cheap and harmless.
 */
export const createPageLifecycle = (
  target: {
    document: Pick<Document, "visibilityState" | "addEventListener"> &
      Pick<Document, "removeEventListener">;
    window: Pick<Window, "addEventListener" | "removeEventListener">;
  } = { document, window },
  now = () => Date.now(),
): LifecycleSignals => ({
  onForeground(listener) {
    let hiddenAt: number | null =
      target.document.visibilityState === "hidden" ? now() : null;
    const onVisibility = () => {
      if (target.document.visibilityState === "hidden") {
        hiddenAt ??= now();
        return;
      }
      if (hiddenAt === null) return;
      const hiddenMs = now() - hiddenAt;
      hiddenAt = null;
      listener(hiddenMs);
    };
    // Restored from the back/forward cache: everything was frozen.
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) {
        listener(Number.POSITIVE_INFINITY);
      }
    };
    target.document.addEventListener("visibilitychange", onVisibility);
    target.window.addEventListener("pageshow", onPageShow);
    return () => {
      target.document.removeEventListener("visibilitychange", onVisibility);
      target.window.removeEventListener("pageshow", onPageShow);
    };
  },
  onOnline(listener) {
    target.window.addEventListener("online", listener);
    return () => target.window.removeEventListener("online", listener);
  },
});
