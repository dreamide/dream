/**
 * One per-store owner of catalog readiness, shared by every host trigger.
 * Every catalog it reads is checked first: that the host that answered is
 * the one the connection is for (or, newly verified, no other connection's),
 * that this app speaks its protocol, and that its ids collide with no other
 * host's. A catalog that fails is never applied.
 */
import type { CatalogResponse } from "@/lib/api-client";
import { getClientPlatform } from "@/lib/connections/platform";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import {
  acceptHostDescriptor,
  findCatalogIdCollisions,
  listHostChoices,
} from "../../../../electron/shared/host-connections.js";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { catalogBaselines } from "./catalog-baselines";
import { loadCatalog } from "./ide-store-persistence";
import type { IdeStoreGet, IdeStoreSet } from "./ide-store-types";

/**
 * The host that answered is not one this connection may load: another
 * host, one already open under another connection, an incompatible
 * protocol or colliding ids. Retrying the same route will not help.
 */
export class HostIdentityError extends Error {
  override name = "HostIdentityError";
}

const lifecycles = new WeakMap<
  IdeStoreGet,
  ReturnType<typeof createLifecycle>
>();

export const hostCatalogLifecycle = (set: IdeStoreSet, get: IdeStoreGet) => {
  let lifecycle = lifecycles.get(get);
  if (!lifecycle) {
    lifecycle = createLifecycle(set, get);
    lifecycles.set(get, lifecycle);
  }
  return lifecycle;
};

function createLifecycle(set: IdeStoreSet, get: IdeStoreGet) {
  const pending = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  const suspended = new Set<string>();
  const connections = new Map<string, AbortController>();
  const connection = (hostId: string) => {
    let controller = connections.get(hostId);
    if (!controller) {
      controller = new AbortController();
      connections.set(hostId, controller);
    }
    return controller;
  };

  const readiness = (hostId: string, loaded: boolean, error: string | null) => {
    if (hostId === LOCAL_HOST_ID) return;
    set((state) => {
      const host = state.hosts?.[hostId];
      if (!host) return state;
      return {
        hosts: { ...state.hosts, [hostId]: { ...host, loaded, error } },
      };
    });
  };

  const labelOf = (connectionId: string) =>
    connectionId === LOCAL_HOST_ID
      ? getClientPlatform().homeLabel
      : (listHostChoices(get().hostConnections, get().settings.sshHosts).find(
          (host) => host.id === connectionId,
        )?.label ?? connectionId);

  /**
   * Checks whose catalog this is before anything of it is applied, and
   * saves the connection's host the first time it is verified. Throws a
   * HostIdentityError for a catalog that must not be applied. The local
   * host's own catalog is never refused for colliding ids: it is the one
   * the others' are checked against.
   */
  const accept = (
    hostId: string,
    catalog: Pick<CatalogResponse, "host"> & Partial<CatalogResponse>,
  ) => {
    const state = get();
    const accepted = acceptHostDescriptor(state.hostConnections, {
      connectionId: hostId,
      descriptor: catalog.host,
      homeRoute: getClientPlatform().homeRoute,
      labelOf,
    });
    if (accepted.error) throw new HostIdentityError(accepted.error);
    if (hostId !== LOCAL_HOST_ID) {
      const collisions = findCatalogIdCollisions({
        catalog,
        chats: state.chats,
        connectionId: hostId,
        projects: [...state.projects, ...state.closedProjects],
      });
      const count = collisions.projectIds.length + collisions.chatIds.length;
      if (count > 0) {
        throw new HostIdentityError(
          `“${labelOf(hostId)}” has ${count === 1 ? "a project or chat" : `${count} projects or chats`} with the same id as another host's here, as if its data were copied from that host. It was not loaded, so the two hosts are not mixed up.`,
        );
      }
    }
    if (accepted.connections !== state.hostConnections) {
      set({ hostConnections: accepted.connections });
    }
  };

  return {
    accept,
    /** Internal read seam: accept the result and apply it in the same turn. */
    async read(
      hostId: string,
      apply: (catalog: Awaited<ReturnType<typeof loadCatalog>>) => void,
    ) {
      const { signal } = connection(hostId);
      signal.throwIfAborted();
      const catalog = await loadCatalog(hostId, undefined, signal);
      signal.throwIfAborted();
      accept(hostId, catalog);
      apply(catalog);
    },
    /** Transport is going away. Keep saved baselines, but reject old reads. */
    suspend(hostId: string) {
      suspended.add(hostId);
      connection(hostId).abort();
      pending.delete(hostId);
      readiness(hostId, false, null);
    },
    /** A new transport connection may now bring its catalog in. */
    resume(hostId: string) {
      suspended.delete(hostId);
      if (connection(hostId).signal.aborted)
        connections.set(hostId, new AbortController());
    },
    refresh(hostId: string): Promise<void> {
      if (get().stateHydrated === false)
        return Promise.reject(new Error("The workspace has not loaded yet."));
      if (suspended.has(hostId))
        return Promise.reject(
          new DOMException("Host catalog load superseded.", "AbortError"),
        );
      const current = pending.get(hostId);
      if (current) return current.promise;
      const controller = connection(hostId);
      readiness(hostId, false, null);
      // Defer the load so synchronous host events also find the pending entry.
      const promise = Promise.resolve()
        .then(async () => {
          controller.signal.throwIfAborted();
          // A host this client has a baseline for is reloaded against it;
          // one it has none for is loaded afresh (catalog-baselines.ts).
          if (catalogBaselines.hasBaseline(hostId))
            await get().reloadCatalog(hostId);
          else await get().loadHostCatalog(hostId);
          controller.signal.throwIfAborted();
          readiness(hostId, true, null);
          for (const project of get().projects) {
            if (getProjectHostId(project) === hostId)
              get().bumpProjectGitRefreshKey?.(project.id);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            readiness(
              hostId,
              false,
              error instanceof Error ? error.message : String(error),
            );
          throw error;
        })
        .finally(() => {
          if (pending.get(hostId)?.controller === controller)
            pending.delete(hostId);
        });
      pending.set(hostId, { controller, promise });
      return promise;
    },
  };
}
