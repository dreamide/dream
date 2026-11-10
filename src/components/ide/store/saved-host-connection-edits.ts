// Saved connection edits own verification, publication and retirement. An
// accepted edit or removal invalidates older verification; transports and
// catalog recovery remain with host-actions and the connection runtime.
import { connectionSupervisor } from "@/lib/connections/runtime";
import { getDesktopApi } from "@/lib/electron";
import { forgetHostSocketClient } from "@/lib/host-socket";
import type { HostRoute, SavedHostConnection } from "@/types/ide";
import {
  findHostConnection,
  forgetHostConnection,
  MAX_HOST_ROUTES,
} from "../../../../electron/shared/host-connections.js";
import { terminalSessions } from "../terminal-session";
import { HostIdentityError } from "./host-catalog-lifecycle";
import { forgetLoadedHost } from "./ide-store-persistence";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { applyWorkspaceRemoval } from "./project-runtime-state";
import { settleSettings } from "./settings-actions";
import * as workspace from "./workspace-document";

type EditActions = Pick<
  IdeState,
  | "removeSshHost"
  | "pairHost"
  | "addSshRoute"
  | "setHostRoutes"
  | "renameHostConnection"
  | "updateSshHost"
>;

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

export const createSavedHostConnectionEdits = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  {
    invalidateConnection,
    reconnect,
  }: {
    invalidateConnection: (id: string) => void;
    reconnect: (id: string) => Promise<boolean>;
  },
) => {
  const revisions = new Map<string, number>();
  // Keep identity tombstones too: a pairing that started before a different
  // pairing added and then removed this Host must not bring it back.
  const identityRevisions = new Map<string, number>();
  const removing = new Set<string>();
  const connections = () => get().hostConnections ?? [];
  const saved = (id: string) => findHostConnection(connections(), id);
  const revision = (id: string) => revisions.get(id) ?? 0;
  const assertEditable = (id: string) => {
    if (removing.has(id)) throw new Error("This connection is being removed.");
  };
  const invalidate = (id: string) => {
    revisions.set(id, revision(id) + 1);
    const identity = saved(id)?.hostId;
    if (identity)
      identityRevisions.set(
        identity,
        (identityRevisions.get(identity) ?? 0) + 1,
      );
    invalidateConnection(id);
  };
  const capture = (id: string) => {
    assertEditable(id);
    const before = saved(id);
    if (!before)
      throw new Error("Connect this host before editing its routes.");
    const version = revision(id);
    return () => {
      assertEditable(id);
      const current = saved(id);
      if (
        !current ||
        revision(id) !== version ||
        current.hostId !== before.hostId ||
        current.fingerprint !== before.fingerprint
      ) {
        throw new Error(
          "This connection changed while the route was being verified. Try again.",
        );
      }
      return current;
    };
  };
  const checkRoutes = (routes: HostRoute[]) => {
    if (
      !routes.length ||
      routes.length > MAX_HOST_ROUTES ||
      new Set(routes.map((route) => route.id)).size !== routes.length
    ) {
      throw new Error(
        `Keep between one and ${MAX_HOST_ROUTES} distinct routes on a connection.`,
      );
    }
  };
  const live = (id: string) =>
    ["connected", "connecting", "reconnecting"].includes(
      get().hosts[id]?.state ?? "",
    );
  const publish = (
    id: string,
    update: (state: IdeState) => Partial<IdeState>,
  ) => {
    assertEditable(id);
    const previousIdentity = saved(id)?.hostId;
    invalidate(id);
    set(update);
    const identity = saved(id)?.hostId;
    if (identity && identity !== previousIdentity) {
      identityRevisions.set(
        identity,
        (identityRevisions.get(identity) ?? 0) + 1,
      );
    }
    get().persist?.();
    return revision(id);
  };
  const refresh = async (id: string, version: number) => {
    if (
      !removing.has(id) &&
      revision(id) === version &&
      (saved(id) || get().settings.sshHosts.some((host) => host.id === id))
    ) {
      await reconnect(id);
    }
  };
  const retire = async (routes: HostRoute[]) => {
    const stillUsed = () => connections().flatMap((host) => host.routes);
    const sshIds = new Set(
      routes.flatMap((route) =>
        route.kind === "ssh" &&
        !stillUsed().some(
          (current) =>
            current.kind === "ssh" && current.sshHostId === route.sshHostId,
        )
          ? [route.sshHostId]
          : [],
      ),
    );
    if (sshIds.size) {
      get().setSettings((settings) => ({
        ...settings,
        sshHosts: settings.sshHosts.filter((host) => !sshIds.has(host.id)),
      }));
    }
    // Check references at retirement time, after any reconnect has settled.
    // A replaced credential must never take a currently saved route with it.
    await Promise.all(
      routes.map(async (route) => {
        if (
          route.kind === "https" &&
          !stillUsed().some(
            (current) =>
              current.kind === "https" &&
              current.credentialId === route.credentialId,
          )
        ) {
          await getDesktopApi()?.forgetHostCredential(route.credentialId);
        }
      }),
    );
  };
  const replace = (state: IdeState, connection: SavedHostConnection) => ({
    hostConnections: (state.hostConnections ?? []).map((host) =>
      host.id === connection.id ? connection : host,
    ),
  });

  const actions: EditActions = {
    removeSshHost: async (hostId) => {
      assertEditable(hostId);
      removing.add(hostId);
      invalidate(hostId);
      try {
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
            hostConnections: forgetHostConnection(
              state.hostConnections,
              hostId,
            ),
            hosts,
          };
        });
        get().persist();
        await retire(removedConnection?.routes ?? []);
      } finally {
        removing.delete(hostId);
      }
    },

    pairHost: async (how, label, connectionId, replaceRouteId) => {
      const api = getDesktopApi();
      if (!api)
        throw new Error("Pairing remote routes requires the desktop app.");
      const currentTarget = connectionId ? capture(connectionId) : null;
      const target = currentTarget?.();
      const identitiesBefore = new Map(identityRevisions);
      const known = new Map(
        connections().map((host) => [
          host.hostId,
          { id: host.id, version: revision(host.id) },
        ]),
      );
      const paired = await api.pairHostWithCode({
        address: how.address,
        code: how.code,
        attemptId: how.attemptId,
        knownIdentities: connections().map(({ hostId, fingerprint }) => ({
          hostId,
          fingerprint,
        })),
        ...(target
          ? {
              expectedHostId: target.hostId,
              expectedFingerprint: target.fingerprint,
            }
          : {}),
      });
      let accepted = false;
      try {
        currentTarget?.();
        if (
          (identityRevisions.get(paired.host.hostId) ?? 0) !==
          (identitiesBefore.get(paired.host.hostId) ?? 0)
        ) {
          throw new Error("This connection changed while pairing. Try again.");
        }
        const prior = known.get(paired.host.hostId);
        if (prior) assertEditable(prior.id);
        const other = connections().find(
          (host) => host.hostId === paired.host.hostId,
        );
        if (
          (!prior && other) ||
          (prior &&
            (other?.id !== prior.id || revision(prior.id) !== prior.version))
        ) {
          throw new Error("This connection changed while pairing. Try again.");
        }
        if (
          (target &&
            (paired.host.hostId !== target.hostId ||
              paired.host.fingerprint !== target.fingerprint)) ||
          (other?.fingerprint && other.fingerprint !== paired.host.fingerprint)
        ) {
          throw new HostIdentityError(
            "This host id belongs to a different saved key.",
          );
        }
        const id = other?.id ?? crypto.randomUUID();
        assertEditable(id);
        const replaced = other?.routes.find(
          (route) =>
            route.id === replaceRouteId ||
            (route.kind === "https" && route.origin === paired.origin),
        );
        if (replaced && replaced.kind !== "https") {
          throw new Error(
            "Only a paired HTTPS route can be replaced by pairing.",
          );
        }
        if (
          replaceRouteId &&
          !other?.routes.some((route) => route.id === replaceRouteId)
        ) {
          throw new Error("The route being replaced no longer exists.");
        }
        const route: HostRoute = {
          id: replaced?.id ?? crypto.randomUUID(),
          kind: "https",
          origin: paired.origin,
          credentialId: paired.credentialId,
        };
        const routes =
          replaced && other
            ? other.routes.map((item) =>
                item.id === replaced.id ? route : item,
              )
            : [...(other?.routes ?? []), route];
        checkRoutes(routes);
        const version = publish(id, (state) => ({
          hostConnections: other
            ? replace(state, {
                ...other,
                ...(label.trim() ? { label: label.trim() } : {}),
                routes,
              }).hostConnections
            : [
                ...(state.hostConnections ?? []),
                {
                  version: 1,
                  id,
                  label: label.trim() || paired.origin,
                  hostId: paired.host.hostId,
                  fingerprint: paired.host.fingerprint,
                  verifiedAt: new Date().toISOString(),
                  routes,
                },
              ],
        }));
        accepted = true;
        try {
          await refresh(id, version);
        } finally {
          await retire(replaced ? [replaced] : []);
        }
        return id;
      } finally {
        if (!accepted)
          await retire([
            {
              id: "",
              kind: "https",
              origin: paired.origin,
              credentialId: paired.credentialId,
            },
          ]);
      }
    },

    addSshRoute: async (connectionId, values) => {
      const current = capture(connectionId);
      const before = current();
      const api = getDesktopApi();
      if (!api) throw new Error("Adding SSH routes requires the desktop app.");
      const id = crypto.randomUUID();
      const route: HostRoute = { id: `ssh:${id}`, kind: "ssh", sshHostId: id };
      checkRoutes([...before.routes, route]);
      let version: number;
      try {
        await api.connectHost({
          hostId: id,
          target: values.target,
          expectedHostId: before.hostId,
          expectedFingerprint: before.fingerprint,
        });
        const connection = current();
        const routes: HostRoute[] = [...connection.routes, route];
        checkRoutes(routes);
        version = publish(connectionId, (state) => ({
          ...settleSettings(state, {
            ...state.settings,
            sshHosts: [...state.settings.sshHosts, { ...values, id }],
          }),
          ...replace(state, { ...connection, routes }),
        }));
      } finally {
        await api.disconnectHost(id);
      }
      await refresh(connectionId, version);
    },

    setHostRoutes: async (id, routes) => {
      const connection = capture(id)();
      checkRoutes(routes);
      if (
        routes.some((route) => !connection.routes.includes(route)) ||
        connection.routes.some(
          (route) => route.kind === "local" && !routes.includes(route),
        )
      ) {
        throw new Error(
          "Keep the local route and use only this connection's saved routes.",
        );
      }
      const removed = connection.routes.filter(
        (route) => !routes.includes(route),
      );
      const wasLive = live(id);
      const version = publish(id, (state) =>
        replace(state, { ...connection, routes }),
      );
      try {
        if (wasLive) await refresh(id, version);
      } finally {
        await retire(removed);
      }
    },

    renameHostConnection: (id, label) => {
      assertEditable(id);
      const connection = saved(id);
      if (!connection)
        throw new Error("Only a saved connection can be renamed.");
      const name = label.trim().slice(0, 200);
      if (name === (connection.label ?? "")) return;
      const { label: _previous, ...rest } = connection;
      set((state) => replace(state, name ? { ...rest, label: name } : rest));
      get().persist();
    },

    updateSshHost: async (hostId, patch) => {
      const previous = get().settings.sshHosts.find(
        (host) => host.id === hostId,
      );
      if (!previous) return;
      const owner =
        connections().find((host) =>
          host.routes.some(
            (route) => route.kind === "ssh" && route.sshHostId === hostId,
          ),
        )?.id ?? hostId;
      assertEditable(owner);
      const next = { ...previous, ...patch, id: hostId };
      const changed = next.target !== previous.target;
      const wasLive = live(owner);
      if (changed) invalidate(owner);
      get().setSettings((settings) => ({
        ...settings,
        sshHosts: settings.sshHosts.map((host) =>
          host.id === hostId ? next : host,
        ),
      }));
      if (changed && wasLive) await refresh(owner, revision(owner));
    },
  };

  return {
    actions,
    isRemoving: (id: string) => removing.has(id),
    merge(id: string, identity: { hostId: string; fingerprint: string }) {
      assertEditable(id);
      const other = connections().find(
        (host) => host.id !== id && host.hostId === identity.hostId,
      );
      if (!other) return null;
      assertEditable(other.id);
      if (other.fingerprint && other.fingerprint !== identity.fingerprint) {
        throw new HostIdentityError(
          "This host id belongs to a different saved key.",
        );
      }
      const incoming: HostRoute[] = saved(id)?.routes ?? [
        { id: `ssh:${id}`, kind: "ssh", sshHostId: id },
      ];
      const routes = [
        ...other.routes,
        ...incoming.filter(
          (route) => !other.routes.some((known) => known.id === route.id),
        ),
      ];
      checkRoutes(routes);
      invalidate(id);
      const version = publish(other.id, (state) => ({
        ...workspace.reassignHost(state, id, other.id),
        hostConnections: (state.hostConnections ?? [])
          .filter((host) => host.id !== id)
          .map((host) => (host.id === other.id ? { ...host, routes } : host)),
      }));
      return { id: other.id, refresh: () => refresh(other.id, version) };
    },
  };
};
