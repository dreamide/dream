/**
 * Each host's catalog baseline on this client: what this client last knew a
 * host's catalog held, its projects and their chats. Every save is compared
 * with a host's baseline, and only the difference goes to that host
 * (catalog-sync.ts). A host gets a baseline when its catalog first loads
 * here (the home host's at startup, an SSH host's when it connects). It
 * keeps it while away, so a reconnect reloads against it, and loses it only
 * when this client forgets the host.
 *
 * Not readiness: whether a host's catalog is applied on the current
 * connection belongs to the host catalog lifecycle
 * (host-catalog-lifecycle.ts), which loads a host with no baseline afresh and
 * reloads one that has one.
 */
import type { UIMessage } from "ai";
import { type ApiClient, apiClient } from "@/lib/api-client";
import { LOCAL_HOST_ID, resolveRequestHost } from "@/lib/host-routing";
import type { ChatConfig, PersistedIdeState, ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import {
  type CatalogConflict,
  type CatalogState,
  createCatalogSync,
} from "./catalog-sync";

type CatalogRoutes = Pick<
  ApiClient,
  "catalogChanges" | "saveCatalogTranscript"
>;

const emptyCatalogState = (): CatalogState => ({
  chats: [],
  closedProjects: [],
  projects: [],
});

/**
 * What of `state` is `hostId`'s catalog: its projects, open and closed, and
 * their chats. Nothing else: a project another host owns, shown from a
 * snapshot, is not this host's, and counting it would have this host's next
 * reload remove it and the next save delete it there.
 */
export const catalogStateOn = (
  hostId: string,
  state: CatalogState,
): CatalogState => {
  const onHost = (project: ProjectConfig) =>
    getProjectHostId(project) === hostId;
  const projects = state.projects.filter(onHost);
  const closedProjects = state.closedProjects.filter(onHost);
  const ids = new Set([...projects, ...closedProjects].map((p) => p.id));
  return {
    chats: state.chats.filter((chat) => ids.has(chat.projectId)),
    closedProjects,
    projects,
  };
};

/** `state` split by host: each project, and each chat by its project. */
const partitionByHost = (
  state: CatalogState,
  hostOf: (projectId: string) => string,
) => {
  const parts = new Map<string, CatalogState>();
  const part = (hostId: string) => {
    let entry = parts.get(hostId);
    if (!entry) {
      entry = emptyCatalogState();
      parts.set(hostId, entry);
    }
    return entry;
  };
  for (const project of state.projects) {
    part(getProjectHostId(project)).projects.push(project);
  }
  for (const project of state.closedProjects) {
    part(getProjectHostId(project)).closedProjects.push(project);
  }
  for (const chat of state.chats) {
    part(hostOf(chat.projectId)).chats.push(chat);
  }
  return parts;
};

export interface CatalogBaselinesDependencies {
  /** The catalog routes of `hostId`. */
  routesFor: (hostId: string) => CatalogRoutes;
  /** A host refused projects it already has at their paths. */
  onConflicts: (hostId: string, conflicts: CatalogConflict[]) => void;
}

export const createCatalogBaselines = ({
  onConflicts,
  routesFor,
}: CatalogBaselinesDependencies) => {
  const syncs = new Map<string, ReturnType<typeof createCatalogSync>>();
  const baselines = new Set<string>();

  /** This client's link to `hostId`'s catalog, made when first needed. */
  const sync = (hostId: string = LOCAL_HOST_ID) => {
    let link = syncs.get(hostId);
    if (!link) {
      link = createCatalogSync({
        api: routesFor(hostId),
        onConflicts: (conflicts) => onConflicts(hostId, conflicts),
      });
      syncs.set(hostId, link);
    }
    return link;
  };

  return {
    sync,

    /** Whether this client knows what `hostId`'s catalog held. */
    hasBaseline: (hostId: string) => baselines.has(hostId),

    /** The hosts with a baseline: the ones saves describe completely. */
    hostIds: (): ReadonlySet<string> => new Set(baselines),

    /**
     * `hostId`'s catalog just loaded: its baseline is what of `from` is
     * that host's (`catalogStateOn`). Pass the state the catalog loaded
     * into, not one changed since: a chat added after is new to the host.
     */
    adopt(hostId: string, from: CatalogState) {
      sync(hostId).reset(catalogStateOn(hostId, from));
      baselines.add(hostId);
    },

    /** This client forgets `hostId`: its baseline and its link go. */
    forget(hostId: string) {
      baselines.delete(hostId);
      syncs.delete(hostId);
    },

    /**
     * Sends each host with a baseline what changed in its part of the
     * store. `live` is the store's unencoded state, which decides what was
     * removed; `encoded` what deserves saving. A host without a baseline is
     * left alone.
     */
    push(
      encoded: Pick<PersistedIdeState, "chats" | "closedProjects" | "projects">,
      live: CatalogState,
    ) {
      const hostByProjectId = new Map<string, string>();
      for (const project of [...live.projects, ...live.closedProjects]) {
        hostByProjectId.set(project.id, getProjectHostId(project));
      }
      const hostOf = (projectId: string) =>
        hostByProjectId.get(projectId) ?? LOCAL_HOST_ID;
      const liveParts = partitionByHost(live, hostOf);
      const encodedParts = partitionByHost(
        {
          chats: encoded.chats as ChatConfig[],
          closedProjects: encoded.closedProjects,
          projects: encoded.projects,
        },
        hostOf,
      );
      for (const hostId of baselines) {
        void sync(hostId).push(
          liveParts.get(hostId) ?? emptyCatalogState(),
          encodedParts.get(hostId) ?? emptyCatalogState(),
        );
      }
    },

    /** Saves a chat's transcript on the host of its project. */
    saveTranscript: (
      chatId: string,
      messages: UIMessage[],
      mergeOnly = false,
    ) =>
      sync(resolveRequestHost({ chatId })).saveTranscript(
        chatId,
        messages,
        mergeOnly,
      ),

    /** Makes sure `chat` exists on its project's host before a turn starts. */
    ensureChat: (project: ProjectConfig, chat: ChatConfig) =>
      sync(getProjectHostId(project)).ensureChat(project, chat),
  };
};

export type CatalogBaselines = ReturnType<typeof createCatalogBaselines>;

/** Who resolves projects a host refused (the store registers it). */
let conflictHandler: (hostId: string, conflicts: CatalogConflict[]) => void =
  () => {};
export const setCatalogConflictHandler = (
  handler: (hostId: string, conflicts: CatalogConflict[]) => void,
) => {
  conflictHandler = handler;
};

/** This window's baselines, over the route client. */
export const catalogBaselines = createCatalogBaselines({
  onConflicts: (hostId, conflicts) => conflictHandler(hostId, conflicts),
  routesFor: (hostId) => ({
    catalogChanges: (changes, options) =>
      apiClient.catalogChanges(changes, { ...options, hostId }),
    saveCatalogTranscript: (payload, options) =>
      apiClient.saveCatalogTranscript(payload, { ...options, hostId }),
  }),
});
