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

import { getClientPlatform } from "@/lib/connections/platform";
import {
  connectionRecovery,
  connectionSupervisor,
} from "@/lib/connections/runtime";
import type { ConnectionStatus } from "@/lib/connections/supervisor";
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { forgetHostSocketClient } from "@/lib/host-socket";
import type { DesktopApi, HostConnectionState, HostRoute } from "@/types/ide";
import {
  findHostConnection,
  forgetHostConnection,
  listHostChoices,
} from "../../../../electron/shared/host-connections.js";
import { terminalSessions } from "../terminal-session";
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
import { applyWorkspaceRemoval } from "./project-runtime-state";
import { settleSettings } from "./settings-actions";
import * as workspace from "./workspace-document";

// Electron prefixes errors thrown across ipcRenderer.invoke with where they
// came from; the user wants only what went wrong.
const IPC_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    IPC_ERROR_PREFIX,
    "",
  );

/** How long removing a host waits for its terminals to stop. */
const TERMINAL_STOP_WAIT_MS = 5_000;

/** Waits for `work` to settle, or `ms`, whichever comes first. */
const settleWithin = async (work: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
};

/** What a host's operator sees this desktop called when it pairs. */
export const DESKTOP_DEVICE_NAME = "Dream desktop";

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

  // Authenticate a former home host before moving its cached workspace to a
  // remote connection on a desktop that no longer executes locally.
  const promoteFormerHome = (persistentId: string, fingerprint: string) => {
    if (getClientPlatform().hasHomeHost) return;
    const former = findHostConnection(get().hostConnections, LOCAL_HOST_ID);
    if (!former || former.hostId !== persistentId) return;
    if (former.fingerprint && former.fingerprint !== fingerprint)
      throw new HostIdentityError(
        "This host id belongs to a different saved key.",
      );
    const id = crypto.randomUUID();
    set((state) => ({
      ...workspace.reassignHost(state, LOCAL_HOST_ID, id),
      hostConnections: state.hostConnections.map((host) =>
        host.id === LOCAL_HOST_ID
          ? {
              ...host,
              id,
              routes: host.routes.filter((route) => route.kind !== "local"),
            }
          : host,
      ),
    }));
  };

  /**
   * Brings `hostId`'s catalog in. A host refused for who it is gets
   * disconnected, with why; any other failure is left to the caller.
   */
  const refreshCatalog = async (hostId: string) => {
    try {
      await catalogs.refresh(hostId);
      if (!getClientPlatform().hasHomeHost && !get().providerModels?.fetchedAt)
        void get().refreshProviderModels?.();
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
    if (hostId === LOCAL_HOST_ID)
      return Promise.resolve(getClientPlatform().hasHomeHost);
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
                  hostCommand: configured.hostCommand,
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
                  hostCommand:
                    routes[0].kind === "ssh"
                      ? routes[0].hostCommand
                      : undefined,
                }
              : {}),
          expectedFingerprint: saved?.fingerprint ?? null,
          expectedHostId: saved?.hostId ?? null,
          ...(routes.length
            ? {}
            : { hostCommand: config?.hostCommand, target: config?.target }),
          hostId,
        });
        if (!current()) return false;
        // Main authenticated this transport before returning its descriptor.
        // Merge before loading its catalog, so rows retain one connection id.
        if (endpoint.hostId && endpoint.fingerprint) {
          promoteFormerHome(endpoint.hostId, endpoint.fingerprint);
          const other = get().hostConnections.find(
            (host) => host.id !== hostId && host.hostId === endpoint.hostId,
          );
          if (other) {
            if (other.fingerprint && other.fingerprint !== endpoint.fingerprint)
              throw new HostIdentityError(
                "This host id belongs to a different saved key.",
              );
            const incoming: HostRoute[] = saved?.routes ?? [
              { id: `ssh:${hostId}`, kind: "ssh", sshHostId: hostId },
            ];
            const merged = [
              ...other.routes,
              ...incoming.filter(
                (route) => !other.routes.some((known) => known.id === route.id),
              ),
            ];
            if (merged.length > 8)
              throw new Error(
                "A connection supports at most eight routes. Remove a route first.",
              );
            set((state) => ({
              ...workspace.reassignHost(state, hostId, other.id),
              hostConnections: state.hostConnections
                .filter((host) => host.id !== hostId)
                .map((host) =>
                  host.id === other.id ? { ...host, routes: merged } : host,
                ),
            }));
            stopFollowing(hostId);
            await desktopApi.disconnectHost(hostId);
            forgetLoadedHost(hostId);
            forgetHostSocketClient(hostId);
            connectionSupervisor.forget(hostId);
            get().persist();
            await connectHost(other.id);
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
            error: errorMessage(error),
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

  return {
    connectHost,

    pairHost: async (how, label, connectionId, replaceRouteId) => {
      const api = getDesktopApi();
      if (!api)
        throw new Error("Pairing remote routes requires the desktop app.");
      const saved = connectionId
        ? findHostConnection(get().hostConnections, connectionId)
        : null;
      const identity = {
        knownIdentities: get().hostConnections.map(
          ({ hostId, fingerprint }) => ({ hostId, fingerprint }),
        ),
        deviceName: DESKTOP_DEVICE_NAME,
        ...(saved
          ? {
              expectedHostId: saved.hostId,
              expectedFingerprint: saved.fingerprint,
            }
          : {}),
      };
      const paired =
        how.kind === "link"
          ? await api.pairHost({ url: how.url, ...identity })
          : await api.pairHostWithCode({
              address: how.address,
              code: how.code,
              attemptId: how.attemptId,
              ...identity,
            });
      promoteFormerHome(paired.host.hostId, paired.host.fingerprint);
      const other = get().hostConnections.find(
        (host) => host.hostId === paired.host.hostId,
      );
      if (other?.fingerprint && other.fingerprint !== paired.host.fingerprint) {
        await api.forgetHostCredential(paired.credentialId);
        throw new Error("This host id belongs to a different saved key.");
      }
      const id = other?.id ?? crypto.randomUUID();
      const replaced = other?.routes.find(
        (route) =>
          route.id === replaceRouteId ||
          (route.kind === "https" && route.origin === paired.origin),
      );
      if (!replaced && (other?.routes.length ?? 0) >= 8) {
        await api.forgetHostCredential(paired.credentialId);
        throw new Error(
          "Remove a route before adding another; a connection supports eight routes.",
        );
      }
      const route: HostRoute = {
        id: replaced?.id ?? crypto.randomUUID(),
        kind: "https",
        origin: paired.origin,
        credentialId: paired.credentialId,
      };
      set((state) => ({
        hostConnections: other
          ? state.hostConnections.map((host) =>
              host.id === id
                ? {
                    ...host,
                    ...(label.trim() ? { label: label.trim() } : {}),
                    routes: replaced
                      ? host.routes.map((item) =>
                          item.id === replaced.id ? route : item,
                        )
                      : [...host.routes, route],
                  }
                : host,
            )
          : [
              ...state.hostConnections,
              {
                version: 1,
                id,
                label: label.trim() || paired.origin,
                hostId: paired.host.hostId,
                fingerprint: paired.host.fingerprint,
                verifiedAt: new Date().toISOString(),
                routes: [route],
              },
            ],
      }));
      get().persist();
      connecting.delete(id);
      await connectHost(id);
      if (replaced?.kind === "https")
        await api.forgetHostCredential(replaced.credentialId);
      return id;
    },

    addSshRoute: async (connectionId, values) => {
      const saved = findHostConnection(get().hostConnections, connectionId);
      const api = getDesktopApi();
      if (!saved || !api)
        throw new Error("Connect this host before adding routes.");
      if (saved.routes.length >= 8)
        throw new Error("A connection supports at most eight routes.");
      const id = crypto.randomUUID();
      try {
        await api.connectHost({
          hostId: id,
          target: values.target,
          hostCommand: values.hostCommand,
          expectedHostId: saved.hostId,
          expectedFingerprint: saved.fingerprint,
        });
        get().setSettings((settings) => ({
          ...settings,
          sshHosts: [...settings.sshHosts, { ...values, id }],
        }));
        set((state) => ({
          hostConnections: state.hostConnections.map((host) =>
            host.id === connectionId
              ? {
                  ...host,
                  routes: [
                    ...host.routes,
                    { id: `ssh:${id}`, kind: "ssh", sshHostId: id },
                  ],
                }
              : host,
          ),
        }));
        get().persist();
      } finally {
        await api.disconnectHost(id);
      }
      connecting.delete(connectionId);
      await connectHost(connectionId);
    },

    setHostRoutes: async (hostId, routes) => {
      const saved = findHostConnection(get().hostConnections, hostId);
      if (
        !saved ||
        !routes.length ||
        routes.length > 8 ||
        new Set(routes.map((route) => route.id)).size !== routes.length ||
        routes.some((route) => !saved.routes.includes(route))
      )
        throw new Error("Keep at least one saved route on a connection.");
      const removed = saved.routes.filter((route) => !routes.includes(route));
      set((state) => ({
        hostConnections: state.hostConnections.map((host) =>
          host.id === hostId ? { ...host, routes } : host,
        ),
      }));
      get().persist();
      if (
        ["connected", "connecting", "reconnecting"].includes(
          get().hosts[hostId]?.state ?? "",
        )
      ) {
        connecting.delete(hostId);
        await connectHost(hostId);
      }
      const sshIds = new Set(
        removed.flatMap((route) =>
          route.kind === "ssh" ? [route.sshHostId] : [],
        ),
      );
      get().setSettings((settings) => ({
        ...settings,
        sshHosts: settings.sshHosts.filter((host) => !sshIds.has(host.id)),
      }));
      for (const route of removed)
        if (route.kind === "https")
          await getDesktopApi()?.forgetHostCredential(route.credentialId);
    },

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

    updateSshHost: async (hostId, patch) => {
      const previous = get().settings.sshHosts.find(
        (host) => host.id === hostId,
      );
      if (!previous) return;
      const next = { ...previous, ...patch, id: hostId };
      get().setSettings((settings) => ({
        ...settings,
        sshHosts: settings.sshHosts.map((host) =>
          host.id === hostId ? next : host,
        ),
      }));

      // Same host, reached differently: a live connection reconnects with
      // the new settings. Its projects stay (they are keyed by the host's
      // id, which does not change), and so does the host it was verified
      // as: a target that now reaches another host is refused.
      const reachedDifferently =
        next.target !== previous.target ||
        next.hostCommand !== previous.hostCommand;
      const owner =
        (get().hostConnections ?? []).find((host) =>
          host.routes.some(
            (route) => route.kind === "ssh" && route.sshHostId === hostId,
          ),
        )?.id ?? hostId;
      const live = get().hosts[owner]?.state;
      if (
        reachedDifferently &&
        (live === "connected" ||
          live === "connecting" ||
          live === "reconnecting")
      ) {
        connecting.delete(owner);
        await connectHost(owner);
      }
    },

    removeSshHost: async (hostId) => {
      stopFollowing(hostId);
      const beforeRemoval = get();
      for (const projectId of workspace.removeHostProjects(
        beforeRemoval,
        beforeRemoval.settings,
        hostId,
      ).removedProjectIds) {
        terminalSessions.closeProject(projectId);
      }
      // Its shells go with it, stopped while the host can still be reached.
      // A host that does not answer does not hold the removal up; one that
      // is not connected cannot be asked.
      if (get().hosts[hostId]?.state === "connected") {
        const state = get();
        const { removedProjectIds } = workspace.removeHostProjects(
          state,
          state.settings,
          hostId,
        );
        await settleWithin(
          Promise.all(
            removedProjectIds.map((projectId) =>
              get().stopProjectTerminals(projectId),
            ),
          ),
          TERMINAL_STOP_WAIT_MS,
        );
      }
      await getDesktopApi()?.disconnectHost(hostId);
      const removedConnection = findHostConnection(
        get().hostConnections,
        hostId,
      );
      for (const route of removedConnection?.routes ?? [])
        if (route.kind === "https")
          await getDesktopApi()?.forgetHostCredential(route.credentialId);
      // Out of this window only: the host's catalog is not told.
      forgetLoadedHost(hostId);
      forgetHostSocketClient(hostId);
      connectionSupervisor.forget(hostId);
      set((state) => {
        const { [hostId]: _removed, ...hosts } = state.hosts;
        const removed = applyWorkspaceRemoval(
          state,
          workspace.removeHostProjects(state, state.settings, hostId),
        );
        return {
          ...removed,
          ...settleSettings(
            { ...state, ...removed },
            {
              ...state.settings,
              sshHosts: state.settings.sshHosts.filter(
                (host) =>
                  host.id !== hostId &&
                  !removedConnection?.routes.some(
                    (route) =>
                      route.kind === "ssh" && route.sshHostId === host.id,
                  ),
              ),
            },
          ),
          hostConnections: forgetHostConnection(state.hostConnections, hostId),
          hosts,
        };
      });
      get().persist();
    },

    disconnectHost: async (hostId) => {
      stopFollowing(hostId);
      await getDesktopApi()?.disconnectHost(hostId);
      setHost(hostId, { error: null, state: "disconnected" });
    },

    setHostStatus: ({ error, hostId, state, routeId, routes }) => {
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
