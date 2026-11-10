/**
 * SSH hosts in the store: connecting one (the main process runs ssh and
 * the host's daemon; this window then loads the host's catalog), its state
 * as main reports it. A host's
 * projects stay in the store while it is away, so its tabs do not vanish
 * with a dropped connection.
 *
 * An SSH host verified once (its saved connection) connects to that host
 * only: main refuses any other, then and on every reconnect.
 * A catalog refused for its host's identity (host-catalog-lifecycle.ts)
 * disconnects it: nothing of a host that is not the one meant is used.
 */

import {
  connectionRecovery,
  connectionSupervisor,
} from "@/lib/connections/runtime";
import type { ConnectionStatus } from "@/lib/connections/supervisor";
import { desktopErrorMessage, getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { forgetHostSocketClient } from "@/lib/host-socket";
import type { DesktopApi, HostConnectionState } from "@/types/ide";
import {
  findHostConnection,
  listHostChoices,
} from "../../../../electron/shared/host-connections.js";
import {
  HostIdentityError,
  hostCatalogLifecycle,
} from "./host-catalog-lifecycle";
import { forgetLoadedHost } from "./ide-store-persistence";
import type {
  HostRuntimeState,
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
} from "./ide-store-types";
import { createSavedHostConnectionEdits } from "./saved-host-connection-edits";

export const createHostActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
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
  // An SSH host's connection state is the main process's (it owns the ssh
  // session); the supervisor hears it from here.
  const SUPERVISED: Record<HostConnectionState, ConnectionStatus> = {
    connected: "ready",
    connecting: "connecting",
    disconnected: "offline",
    failed: "offline",
    idle: "offline",
    reconnecting: "reconnecting",
  };

  const setHost = (hostId: string, patch: Partial<HostRuntimeState>) => {
    if (patch.state) {
      connectionSupervisor.set(
        hostId,
        SUPERVISED[patch.state],
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
   * Brings `hostId`'s catalog in. A host refused for who it is gets
   * disconnected, with why; any other failure is left to the caller.
   */
  const refreshCatalog = async (hostId: string) => {
    try {
      await catalogs.refresh(hostId);
    } catch (error) {
      if (!(error instanceof HostIdentityError)) throw error;
      stopFollowing(hostId);
      await getDesktopApi()?.disconnectHost(hostId);
      setHost(hostId, { error: error.message, loaded: false, state: "failed" });
      // Not a connection that will come back by retrying.
      connectionSupervisor.set(hostId, "incompatible", error.message);
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
      const config = get().settings.sshHosts.find((host) => host.id === hostId);
      const saved = findHostConnection(get().hostConnections, hostId);
      if (!desktopApi || (!config && !saved)) {
        setHost(hostId, {
          error: "This connection is not in Settings.",
          state: "failed",
        });
        return false;
      }

      setHost(hostId, { error: null, loaded: false, state: "connecting" });
      const routes =
        saved?.routes.flatMap<
          NonNullable<
            Parameters<DesktopApi["connectHost"]>[0]["routes"]
          >[number]
        >((route) => {
          if (route.kind === "https") return [route];
          if (route.kind !== "ssh") return [];
          const configured = get().settings.sshHosts.find(
            (host) => host.id === route.sshHostId,
          );
          return configured
            ? [
                {
                  id: route.id,
                  kind: "ssh" as const,
                  target: configured.target,
                },
              ]
            : [];
        }) ?? [];
      try {
        const endpoint = await desktopApi.connectHost({
          ...(routes.some(
            (route) => route.kind === "https" || route.id !== `ssh:${hostId}`,
          ) || routes.length > 1
            ? { routes }
            : routes.length === 1
              ? {
                  target:
                    routes[0].kind === "ssh" ? routes[0].target : undefined,
                }
              : {}),
          expectedFingerprint: saved?.fingerprint ?? null,
          expectedHostId: saved?.hostId ?? null,
          ...(routes.length ? {} : { target: config?.target }),
          hostId,
        });
        if (!current()) return false;
        // Main authenticated this transport before returning its descriptor.
        // Merge before loading its catalog, so rows retain one connection id.
        if (endpoint.hostId && endpoint.fingerprint) {
          const merged = edits.merge(hostId, {
            hostId: endpoint.hostId,
            fingerprint: endpoint.fingerprint,
          });
          if (merged) {
            await desktopApi.disconnectHost(hostId);
            forgetLoadedHost(hostId);
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
        if (!current()) return false;
        if (error instanceof HostIdentityError) {
          stopFollowing(hostId);
          await desktopApi.disconnectHost(hostId);
          setHost(hostId, {
            error: error.message,
            loaded: false,
            state: "failed",
          });
          return false;
        }
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

    setHostStatus: ({ error, hostId, state, routeId, routes }) => {
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
