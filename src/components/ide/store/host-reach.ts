/**
 * Reaching a Host (GLOSSARY.md, Host reach): whether a host is ready to
 * work with, getting it there, and what this window keeps running while it
 * is. One rule answers "is the host there" for every caller, the home host
 * included:
 *
 *   ready      its connection is up and its catalog is in this window. An
 *              SSH or paired host: main reports it `connected` and its
 *              catalog is `loaded` (store/host-catalog-lifecycle.ts). The
 *              home host is not in `hosts`: its connection is the
 *              connection supervisor's (`ready`), and its catalog comes in
 *              with hydration (`stateHydrated`).
 *   connected  only the transport is up (the catalog may still be loading):
 *              what listing a host's folders needs, and what connection
 *              recovery needs to bring a catalog in.
 *
 * The owner (`createHostReach`, the app's is `hostReach` in ide-store.ts)
 * reaches a host (connects it when it is not ready, and waits for its
 * catalog) and follows host state: catalog events from every watched host,
 * this window's browser lent where the rule says, and main's host status
 * reports. Connecting itself, saved connection edits, the route supervisor
 * and catalog readiness keep their own owners.
 */
import type { StoreApi } from "zustand";
import { connectionSupervisor } from "@/lib/connections/runtime";
import type {
  ConnectionState,
  ConnectionStatus,
} from "@/lib/connections/supervisor";
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type {
  DesktopApi,
  HostConnectionState,
  HostRoute,
  HostStatusEvent,
} from "@/types/ide";
import { watchHostBrowser } from "./host-browser-watch";
import type { IdeState } from "./ide-store-types";

/** The home host's connection, as the connection supervisor has it. */
export type HomeConnection = Pick<ConnectionState, "status" | "error">;

/** What readiness is read from in the store. */
export type ReachState = Pick<IdeState, "hosts" | "stateHydrated">;

/** The store the owner follows. */
export type FollowedStore = Pick<StoreApi<IdeState>, "getState" | "subscribe">;

/** The home host's connection now. */
export const homeConnection = (): HomeConnection =>
  connectionSupervisor.get(LOCAL_HOST_ID);

/** The home host's connection status in the words used for SSH hosts. */
export const HOME_HOST_STATE: Record<ConnectionStatus, HostConnectionState> = {
  connecting: "connecting",
  incompatible: "failed",
  offline: "disconnected",
  ready: "connected",
  reconnecting: "reconnecting",
  unauthorized: "failed",
};

/** Whether `hostId`'s transport is up, its catalog loaded or not. */
export const isHostConnected = (
  state: Pick<IdeState, "hosts">,
  hostId: string,
  home: HomeConnection = homeConnection(),
): boolean =>
  hostId === LOCAL_HOST_ID
    ? home.status === "ready"
    : state.hosts[hostId]?.state === "connected";

/**
 * Whether `hostId` is ready to work with: connected, with its catalog in
 * this window. The one readiness rule; see the module comment.
 */
export const isHostReady = (
  state: ReachState,
  hostId: string,
  home: HomeConnection = homeConnection(),
): boolean =>
  isHostConnected(state, hostId, home) &&
  (hostId === LOCAL_HOST_ID
    ? state.stateHydrated
    : state.hosts[hostId]?.loaded === true);

/**
 * The hosts connection recovery may bring a catalog in for (and resume
 * streams on): none before hydration; then the home host, whose connection
 * the runtime recovers itself, and every host whose transport is up.
 * Transport, not readiness: bringing the catalog in is recovery's job.
 */
export const recoverableHostIds = (
  state: Pick<IdeState, "hosts" | "stateHydrated">,
): string[] =>
  state.stateHydrated
    ? [
        LOCAL_HOST_ID,
        ...Object.entries(state.hosts)
          .filter(([, host]) => host.state === "connected")
          .map(([hostId]) => hostId),
      ]
    : [];

/**
 * The hosts whose catalog events this window follows: the home host's
 * always (its events are how it comes back), any other once its catalog
 * is loaded.
 */
export const watchedHostIds = (hosts: IdeState["hosts"]): string[] => [
  LOCAL_HOST_ID,
  ...Object.entries(hosts)
    .filter(([hostId, host]) => hostId !== LOCAL_HOST_ID && host.loaded)
    .map(([hostId]) => hostId),
];

/**
 * Whether this window lends its browser to `hostId`'s agents: only a
 * desktop has one, a host reached over HTTPS is not lent it, and the home
 * host borrows it only when it runs in its own process (an in-process host
 * already has it). SSH hosts and a detached home host do.
 */
export const lendsBrowser = ({
  desktop,
  hostId,
  route,
}: {
  desktop: Pick<DesktopApi, "hostMode"> | null;
  hostId: string;
  route: Pick<HostRoute, "kind"> | undefined;
}): boolean =>
  !!desktop &&
  route?.kind !== "https" &&
  !(hostId === LOCAL_HOST_ID && desktop.hostMode !== "detached");

export interface HostReachParts {
  /** Connects a host and loads its catalog (the store's `connectHost`). */
  connect?: (hostId: string) => Promise<boolean>;
  /** The home host's connection. */
  home?: () => HomeConnection;
  /**
   * Follows one host's catalog events; returns the stop. Needed to follow
   * (ide-store.ts gives `watchHostCatalog` over the store's host catalogs).
   */
  watchCatalog?: (hostId: string, store: FollowedStore) => () => void;
  /** Lends this window's browser to one host; returns the stop. */
  watchBrowser?: (hostId: string, store: FollowedStore) => () => void;
  /**
   * Writes main's report of a host's connection. Needed to follow
   * (ide-store.ts gives the host actions' `setHostStatus`).
   */
  setHostStatus?: (event: HostStatusEvent) => void;
  /** The desktop bridge; null in a browser. */
  desktop?: () => Pick<DesktopApi, "hostMode" | "onHostStatus"> | null;
}

/** The Host reach owner over a store's state. */
export const createHostReach = (
  get: () => ReachState & Pick<IdeState, "connectHost">,
  {
    connect = (hostId) => get().connectHost(hostId),
    home = homeConnection,
    watchCatalog,
    watchBrowser = watchHostBrowser,
    setHostStatus,
    desktop = getDesktopApi,
  }: HostReachParts = {},
) => {
  const isReady = (state: ReachState, hostId: string) =>
    isHostReady(state, hostId, home());

  return {
    isReady,

    /**
     * Resolves true once `hostId` is ready: at once for the home host
     * (nothing here connects it) and for a host already ready; otherwise
     * after connecting it and loading its catalog, false if that failed.
     */
    reach(hostId: string): Promise<boolean> {
      if (hostId === LOCAL_HOST_ID || isReady(get(), hostId))
        return Promise.resolve(true);
      return connect(hostId);
    },

    /**
     * Follows `store`'s host state until the returned stop: a catalog
     * watcher for each watched host, started again when its route changes,
     * with this window's browser lent where `lendsBrowser` says, and main's
     * host status reports written to the store.
     */
    follow(store: FollowedStore): () => void {
      if (!watchCatalog || !setHostStatus)
        throw new Error(
          "Following hosts needs a catalog watcher and a host status writer.",
        );
      const bridge = desktop();
      const watching = new Map<string, () => void>();
      const routes = new Map<string, string | null | undefined>();

      const sync = (hosts: IdeState["hosts"]) => {
        const wanted = new Set(watchedHostIds(hosts));
        for (const hostId of wanted) {
          const routeId = hosts[hostId]?.routeId;
          if (watching.has(hostId) && routes.get(hostId) === routeId) continue;
          watching.get(hostId)?.();
          routes.set(hostId, routeId);
          const stopCatalog = watchCatalog(hostId, store);
          const route = store
            .getState()
            .hostConnections.find((host) => host.id === hostId)
            ?.routes.find((item) => item.id === routeId);
          const stopBrowser = lendsBrowser({ desktop: bridge, hostId, route })
            ? watchBrowser(hostId, store)
            : null;
          watching.set(hostId, () => {
            stopCatalog();
            stopBrowser?.();
          });
        }
        for (const [hostId, stop] of watching) {
          if (!wanted.has(hostId)) {
            stop();
            watching.delete(hostId);
            routes.delete(hostId);
          }
        }
      };

      sync(store.getState().hosts);
      const unsubscribe = store.subscribe((state, previous) => {
        if (state.hosts !== previous.hosts) sync(state.hosts);
      });
      // What main says about SSH and paired hosts' connections.
      const removeHostStatus = bridge?.onHostStatus((event) =>
        setHostStatus(event),
      );

      return () => {
        unsubscribe();
        removeHostStatus?.();
        for (const stop of watching.values()) stop();
        watching.clear();
        routes.clear();
      };
    },
  };
};

export type HostReach = ReturnType<typeof createHostReach>;
