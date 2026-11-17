/**
 * SSH and paired hosts in the store: connecting one (the main process dials
 * its routes; this window then loads the host's catalog), its state as main
 * reports it. A host's projects stay in the store while it is away, so its
 * tabs do not vanish with a dropped connection.
 *
 * A host verified once (its saved connection) connects to that host only:
 * main refuses any other, then and on every reconnect, and its status says
 * why (`refusal`), which `connectionStatusOf` maps.
 * This window still checks each catalog (host-catalog-lifecycle.ts) for
 * what only it knows: a host another connection already has, or ids that
 * collide with another host's. Such a HostIdentityError, or a merge refused
 * for a different saved key, disconnects it as an identity refusal: nothing
 * of a host that is not the one meant is used.
 */

import {
  connectionRecovery,
  connectionSupervisor,
} from "@/lib/connections/runtime";
import type { ConnectionStatus } from "@/lib/connections/supervisor";
import { desktopErrorMessage, getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { forgetHostSocketClient } from "@/lib/host-socket";
import type { HostConnectionState, HostRefusal } from "@/types/ide";
import {
  findHostConnection,
  listHostChoices,
} from "../../../../electron/shared/host-connections.js";
import { routesToDial } from "../../../../electron/shared/routes-to-dial.js";
import { catalogBaselines } from "./catalog-baselines";
import {
  HostIdentityError,
  hostCatalogLifecycle,
} from "./host-catalog-lifecycle";
import type {
  HostRuntimeState,
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
} from "./ide-store-types";
import { createSavedHostConnectionEdits } from "./saved-host-connection-edits";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";

// A host's connection state is the main process's (it owns the routes); the
// supervisor hears it through this one mapping. A connection that failed for
// good says why: a refused credential is `unauthorized`; another host, or a
// protocol this app does not speak, is `incompatible`.
const SUPERVISED: Record<HostConnectionState, ConnectionStatus> = {
  connected: "ready",
  connecting: "connecting",
  disconnected: "offline",
  failed: "offline",
  idle: "offline",
  reconnecting: "reconnecting",
};
const REFUSED: Record<HostRefusal, ConnectionStatus> = {
  identity: "incompatible",
  protocol: "incompatible",
  unauthorized: "unauthorized",
};

/** The connection status of a host main reports as `state`, refused for `refusal`. */
export const connectionStatusOf = (
  state: HostConnectionState,
  refusal: HostRefusal | null | undefined,
): ConnectionStatus =>
  state === "failed" && refusal ? REFUSED[refusal] : SUPERVISED[state];

export const createHostActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  terminals: TerminalSessionOwner = createTerminalSessionOwner(set, get),
): Pick<
  IdeState,
  | "connectHost"
  | "resumeHosts"
  | "updateSshHost"
  | "disconnectHost"
  | "setHostStatus"
  | "removeSshHost"
  | "pairHost"
  | "addSshRoute"
  | "setHostRoutes"
  | "renameHostConnection"
> => {
  const setHost = (hostId: string, patch: Partial<HostRuntimeState>) => {
    if (patch.state) {
      // A refusal main reported stays with the host until its next status
      // or connect, so a connect's rejection does not hide why.
      const refusal =
        "refusal" in patch ? patch.refusal : get().hosts[hostId]?.refusal;
      connectionSupervisor.set(
        hostId,
        connectionStatusOf(patch.state, refusal),
        patch.error ?? null,
      );
    }
    set((state) => ({
      hosts: {
        ...state.hosts,
        [hostId]: {
          ...{ error: null, loaded: false, state: "idle" as const },
          ...state.hosts[hostId],
          ...patch,
        },
      },
    }));
  };

  const catalogs = hostCatalogLifecycle(set, get);
  const connecting = new Map<
    string,
    { token: symbol; promise: Promise<boolean> }
  >();
  const stopped = new Set<string>();
  const stopFollowing = (hostId: string) => {
    stopped.add(hostId);
    connecting.delete(hostId);
    catalogs.suspend(hostId);
  };

  /**
   * A host this window refused for who it is: disconnected, with why. Not a
   * connection that will come back by retrying.
   */
  const refuse = async (hostId: string, error: HostIdentityError) => {
    stopFollowing(hostId);
    await getDesktopApi()?.disconnectHost(hostId);
    setHost(hostId, {
      error: error.message,
      loaded: false,
      refusal: "identity",
      state: "failed",
    });
  };

  /**
   * Brings `hostId`'s catalog in. A host refused for who it is gets
   * refused; any other failure is left to the caller.
   */
  const refreshCatalog = async (hostId: string) => {
    try {
      await catalogs.refresh(hostId);
    } catch (error) {
      if (error instanceof HostIdentityError) await refuse(hostId, error);
      throw error;
    }
  };

  const connectHost: IdeState["connectHost"] = (hostId) => {
    if (edits.isRemoving(hostId)) return Promise.resolve(false);
    if (hostId === LOCAL_HOST_ID) return Promise.resolve(true);
    const pending = connecting.get(hostId);
    if (pending) return pending.promise;
    const token = Symbol(hostId);
    const current = () => connecting.get(hostId)?.token === token;
    stopped.delete(hostId);
    catalogs.resume(hostId);

    const run = (async () => {
      const desktopApi = getDesktopApi();
      // A saved connection's routes, or an SSH host's own from Settings.
      const request = routesToDial({
        connectionId: hostId,
        saved: findHostConnection(get().hostConnections, hostId),
        sshHosts: get().settings.sshHosts,
      });
      if (!desktopApi || !request.routes.length) {
        setHost(hostId, {
          error: "This connection is not in Settings.",
          refusal: null,
          state: "failed",
        });
        return false;
      }

      setHost(hostId, {
        error: null,
        loaded: false,
        refusal: null,
        state: "connecting",
      });
      try {
        const endpoint = await desktopApi.connectHost(request);
        if (!current()) return false;
        // Main authenticated this transport before returning its descriptor.
        // Merge before loading its catalog, so rows retain one connection id.
        if (endpoint.hostId && endpoint.fingerprint) {
          let merged: ReturnType<typeof edits.merge>;
          try {
            merged = edits.merge(hostId, {
              hostId: endpoint.hostId,
              fingerprint: endpoint.fingerprint,
            });
          } catch (error) {
            if (!(error instanceof HostIdentityError)) throw error;
            await refuse(hostId, error);
            return false;
          }
          if (merged) {
            await desktopApi.disconnectHost(hostId);
            catalogBaselines.forget(hostId);
            forgetHostSocketClient(hostId);
            connectionSupervisor.forget(hostId);
            await merged.refresh();
            return false;
          }
        }
        setHost(hostId, {
          state: "connected",
          ...(endpoint.routeId
            ? { routeId: endpoint.routeId, routes: endpoint.routes }
            : {}),
        });
        await refreshCatalog(hostId);
        return current();
      } catch (error) {
        // A HostIdentityError was refused where it was thrown.
        if (!current() || error instanceof HostIdentityError) return false;
        if (current())
          setHost(hostId, {
            error: desktopErrorMessage(error),
            loaded: false,
            state:
              get().hosts[hostId]?.state === "connected"
                ? "connected"
                : "failed",
          });
        return false;
      }
    })().finally(() => {
      if (current()) connecting.delete(hostId);
    });
    connecting.set(hostId, { token, promise: run });
    return run;
  };

  const edits = createSavedHostConnectionEdits(set, get, {
    invalidateConnection: stopFollowing,
    reconnect: connectHost,
    terminals,
  });

  return {
    ...edits.actions,
    connectHost,

    resumeHosts: async (openHostIds) => {
      const desktopApi = getDesktopApi();
      const reopen = new Set(openHostIds);
      await Promise.all(
        listHostChoices(get().hostConnections, get().settings.sshHosts).map(
          async (host) => {
            // Main keeps its connections across a reload of this window; ask
            // it rather than assume nothing is connected.
            const mainState = await desktopApi
              ?.getHostState(host.id)
              .catch(() => "idle" as const);
            if (
              stopped.has(host.id) ||
              !listHostChoices(
                get().hostConnections,
                get().settings.sshHosts,
              ).some((item) => item.id === host.id)
            )
              return;
            if (mainState === "connected") {
              // Already there: connecting returns at once, without prompts.
              await connectHost(host.id);
            } else if (
              mainState === "connecting" ||
              mainState === "reconnecting"
            ) {
              // On its way: its status event brings the catalog in.
              setHost(host.id, { error: null, state: mainState });
            } else if (reopen.has(host.id)) {
              // Projects of it were open last time: connect again.
              await connectHost(host.id);
            }
          },
        ),
      );
    },

    disconnectHost: async (hostId) => {
      stopFollowing(hostId);
      await getDesktopApi()?.disconnectHost(hostId);
      setHost(hostId, { error: null, state: "disconnected" });
    },

    setHostStatus: ({ error, hostId, refusal, state, routeId, routes }) => {
      if (edits.isRemoving(hostId)) return;
      if (
        !listHostChoices(get().hostConnections, get().settings.sshHosts).some(
          (host) => host.id === hostId,
        )
      )
        return;
      if (state === "connected" && stopped.has(hostId)) return;
      const previous = get().hosts[hostId]?.state;
      const previousRoute = get().hosts[hostId]?.routeId;
      const replaced =
        state === "connected" &&
        previousRoute &&
        routeId &&
        previousRoute !== routeId;
      if (state !== "connected" && state !== "connecting") {
        connecting.delete(hostId);
        catalogs.suspend(hostId);
      }
      setHost(hostId, {
        error,
        refusal: refusal ?? null,
        state,
        ...(routeId !== undefined ? { routeId, routes } : {}),
      });
      if (replaced && !connecting.has(hostId)) {
        void connectionRecovery.replace(hostId);
        return;
      }
      // Connected without this window asking (back after a drop, or a
      // connection main had before this window reloaded): bring the
      // catalog in. A connect this window started does that itself.
      if (
        state === "connected" &&
        previous !== "connected" &&
        !connecting.has(hostId)
      ) {
        catalogs.resume(hostId);
        void refreshCatalog(hostId).catch(() => undefined);
      }
    },
  };
};
