/**
 * Applying hosts' catalogs to the store: what another client (or the host
 * itself, running a turn) changed arrives as catalog events and lands here,
 * as does an SSH host's whole catalog when it connects. Workspace fields
 * (open or closed, per-project UI) stay this window's; a project another
 * client added arrives closed. Every project is stamped with its host,
 * which a host's own catalog does not say.
 *
 * Only `refreshHostCatalog` is a store action. The rest is the store's own
 * wiring, handed to the modules that call it (ide-store.ts): catalog
 * readiness (the lifecycle built here) loads and reloads through it, the
 * catalog watcher applies events through it, and the conflict handler
 * adopts a host's projects through it.
 */
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { AgentTurnEnding } from "../../../../electron/shared/agent-turn-contract.js";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { catalogBaselines } from "./catalog-baselines";
import { createHostCatalogLifecycle } from "./host-catalog-lifecycle";
import { getLoadedWorkspace } from "./ide-store-persistence";
import type { IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { commitWorkspaceRemoval } from "./project-runtime-state";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";
import * as workspace from "./workspace-document";

/** The host catalog actions in the store (`IdeState`). */
export interface CatalogActions {
  /** Re-reads a host's whole catalog (after its host socket says to). */
  refreshHostCatalog: (hostId?: string) => Promise<void>;
}

/**
 * Host catalog changes made elsewhere (another client, the host itself):
 * upserted and removed projects and chats. Raw values; they are repaired
 * with the codec.
 */
export interface CatalogChanges {
  projects?: unknown[];
  removedProjectIds?: string[];
  chats?: unknown[];
  removedChatIds?: string[];
}

const isRecordWithId = (
  value: unknown,
): value is Record<string, unknown> & { id: string } =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>).id === "string";

export const createCatalogActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  {
    persist,
    terminals = createTerminalSessionOwner(set, get),
  }: {
    /** Saves every slice now (the save scheduler in ide-store.ts). */
    persist: () => void;
    /** The Terminal session owner, which stops a removed Project's terminals. */
    terminals?: Pick<TerminalSessionOwner, "dropProject">;
  },
) => {
  /** Applies host catalog changes made elsewhere to the store. */
  const applyCatalogChanges = (
    changes: CatalogChanges,
    hostId = LOCAL_HOST_ID,
  ) => {
    const state = get();
    if (!state.stateHydrated) return;
    const removal = workspace.applyCatalogChanges(
      state,
      state.settings,
      hostId,
      changes,
    );
    void commitWorkspaceRemoval(set, terminals, removal);

    // The host has these now; they are not this window's to send back.
    const incomingIds = new Set(
      [...(changes.projects ?? []), ...(changes.chats ?? [])]
        .filter(isRecordWithId)
        .map((item) => item.id),
    );
    const isIncoming = (item: { id: string }) => incomingIds.has(item.id);
    const after = get();
    const sync = catalogBaselines.sync(hostId);
    sync.remember({
      chats: after.chats.filter(isIncoming),
      closedProjects: after.closedProjects.filter(isIncoming),
      projects: after.projects.filter(isIncoming),
    });
    sync.forget({
      chatIds: removal.removedChatIds,
      projectIds: removal.removedProjectIds,
    });
  };

  /**
   * Replaces this host's chats in one of the host chat sets (running turns,
   * awaiting approvals), keeping other hosts' entries.
   */
  const replaceHostChats = (
    field: "hostRunningChatIds" | "hostAwaitingApprovalChatIds",
    hostId: string,
    chatIds: string[],
  ) => {
    const state = get();
    const projectsById = new Map(
      [...state.projects, ...state.closedProjects].map((project) => [
        project.id,
        project,
      ]),
    );
    const hostOfChat = (chatId: string) => {
      const chat = state.chats.find((item) => item.id === chatId);
      const project = chat ? projectsById.get(chat.projectId) : undefined;
      return project ? getProjectHostId(project) : LOCAL_HOST_ID;
    };
    const next: Record<string, true> = {};
    for (const chatId of Object.keys(state[field])) {
      if (hostOfChat(chatId) !== hostId) next[chatId] = true;
    }
    for (const chatId of chatIds) next[chatId] = true;
    set({ [field]: next });
  };
  /** What a host's catalog says is running and waiting on it now. */
  const setRunning = (
    hostId: string,
    catalog: { runningChatIds?: string[]; awaitingApprovalChatIds?: string[] },
  ) => {
    replaceHostChats(
      "hostRunningChatIds",
      hostId,
      catalog.runningChatIds ?? [],
    );
    replaceHostChats(
      "hostAwaitingApprovalChatIds",
      hostId,
      catalog.awaitingApprovalChatIds ?? [],
    );
  };

  /**
   * Projects a host refused because it already has a project at that path:
   * each is replaced by the host's project, in the same place, with its
   * chats moved over.
   */
  const adoptHostProjects = async (
    hostId: string,
    conflicts: { id: string; existingId: string }[],
  ): Promise<void> => {
    // The host's own projects, read from it: the store cannot hold the
    // one it kept beside the refused one (one project per path).
    try {
      await lifecycle.read(hostId, (catalog) => {
        const hostProjects = new Map(
          catalog.projects
            .filter(isRecordWithId)
            .map((project) => [project.id, project]),
        );
        for (const { id, existingId } of conflicts) {
          const keptRow = hostProjects.get(existingId);
          if (!keptRow) continue;
          const state = get();
          void commitWorkspaceRemoval(
            set,
            terminals,
            workspace.adoptProject(state, state.settings, hostId, id, keptRow),
          );
        }
        persist();
      });
    } catch (error) {
      console.warn(`Unable to read the catalog of host ${hostId}.`, error);
      return;
    }
    // Its chats, and anything else the host has that this window lacks.
    await get()
      .refreshHostCatalog(hostId)
      .catch((error: unknown) => {
        console.warn(`Unable to reload the catalog of host ${hostId}.`, error);
      });
  };

  /** A turn started or ended on the host. */
  const setHostTurnRunning = (
    chatId: string,
    running: boolean,
    ending?: AgentTurnEnding,
  ) => {
    const current = get().hostRunningChatIds;
    if (Boolean(current[chatId]) === running) return;
    const next = { ...current };
    if (running) next[chatId] = true;
    else {
      if (ending) chatTurnOutcomes.reportHostEnding(chatId, ending);
      delete next[chatId];
    }
    // A turn that ended waits on nothing.
    if (!running && get().hostAwaitingApprovalChatIds[chatId]) {
      const awaiting = { ...get().hostAwaitingApprovalChatIds };
      delete awaiting[chatId];
      set({
        hostAwaitingApprovalChatIds: awaiting,
        hostRunningChatIds: next,
      });
      return;
    }
    set({ hostRunningChatIds: next });
  };

  /** A chat started or stopped waiting on a tool approval on its host. */
  const setHostChatAwaitingApproval = (chatId: string, awaiting: boolean) => {
    const current = get().hostAwaitingApprovalChatIds;
    if (Boolean(current[chatId]) === awaiting) return;
    const next = { ...current };
    if (awaiting) next[chatId] = true;
    else delete next[chatId];
    set({ hostAwaitingApprovalChatIds: next });
  };

  /** Loads a just-connected host's catalog into the store. */
  const loadHostCatalog = (hostId: string) =>
    lifecycle.read(hostId, (catalog) => {
      const state = get();
      void commitWorkspaceRemoval(
        set,
        terminals,
        workspace.loadHostCatalog(state, state.settings, hostId, {
          catalog,
          workspaceProjects: getLoadedWorkspace().workspaceProjects,
        }),
      );

      // The catalog as it landed in the store is this host's baseline.
      catalogBaselines.adopt(hostId, get());
      setRunning(hostId, catalog);
    });

  /**
   * Reloads a host's catalog against its baseline: what the host had
   * confirmed and no longer has leaves the store.
   */
  const reloadCatalog = async (hostId = LOCAL_HOST_ID) => {
    if (!get().stateHydrated) return;
    await lifecycle.read(hostId, (catalog) => {
      setRunning(hostId, catalog);
      const state = get();
      const sync = catalogBaselines.sync(hostId);
      const catalogProjectIds = new Set(
        catalog.projects.filter(isRecordWithId).map((project) => project.id),
      );
      const catalogChatIds = new Set(
        catalog.chats.filter(isRecordWithId).map((chat) => chat.id),
      );
      // Only what the host had confirmed and no longer has is gone; a
      // change this window has not sent yet is not.
      applyCatalogChanges(
        {
          chats: catalog.chats,
          projects: catalog.projects,
          removedChatIds: state.chats
            .map((chat) => chat.id)
            .filter(
              (id) => !catalogChatIds.has(id) && sync.isSynced("chat", id),
            ),
          removedProjectIds: [...state.projects, ...state.closedProjects]
            .map((project) => project.id)
            .filter(
              (id) =>
                !catalogProjectIds.has(id) && sync.isSynced("project", id),
            ),
        },
        hostId,
      );
    });
  };

  /** Catalog readiness, loading and reloading through the above. */
  const lifecycle = createHostCatalogLifecycle(set, get, {
    load: loadHostCatalog,
    reload: reloadCatalog,
  });

  const actions: CatalogActions = {
    refreshHostCatalog: (hostId = LOCAL_HOST_ID) => lifecycle.refresh(hostId),
  };

  return {
    actions,
    lifecycle,
    adoptHostProjects,
    applyCatalogChanges,
    loadHostCatalog,
    reloadCatalog,
    setHostChatAwaitingApproval,
    setHostTurnRunning,
  };
};

/** The store's host catalogs: its action and its wiring. */
export type HostCatalog = ReturnType<typeof createCatalogActions>;
