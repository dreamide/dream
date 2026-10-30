/**
 * Applying hosts' catalogs to the store: what another client (or the host
 * itself, running a turn) changed arrives as catalog events and lands here,
 * as does an SSH host's whole catalog when it connects. Workspace fields
 * (open or closed, per-project UI) stay this window's; a project another
 * client added arrives closed. Every project is stamped with its host,
 * which a host's own catalog does not say.
 */
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { hostCatalogLifecycle } from "./host-catalog-lifecycle";
import {
  getCatalogSync,
  getLoadedWorkspace,
  markHostLoaded,
} from "./ide-store-persistence";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { commitWorkspaceRemoval } from "./project-runtime-state";
import * as workspace from "./workspace-document";

const isRecordWithId = (
  value: unknown,
): value is Record<string, unknown> & { id: string } =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>).id === "string";

export const createCatalogActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "adoptHostProjects"
  | "applyCatalogChanges"
  | "reloadCatalog"
  | "loadHostCatalog"
  | "refreshHostCatalog"
  | "setHostTurnRunning"
  | "setHostChatAwaitingApproval"
> => {
  const applyCatalogChanges: IdeState["applyCatalogChanges"] = (
    changes,
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
    void commitWorkspaceRemoval(set, get, removal);

    // The host has these now; they are not this window's to send back.
    const incomingIds = new Set(
      [...(changes.projects ?? []), ...(changes.chats ?? [])]
        .filter(isRecordWithId)
        .map((item) => item.id),
    );
    const isIncoming = (item: { id: string }) => incomingIds.has(item.id);
    const after = get();
    const sync = getCatalogSync(hostId);
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

  return {
    applyCatalogChanges,
    refreshHostCatalog: (hostId = LOCAL_HOST_ID) =>
      hostCatalogLifecycle(set, get).refresh(hostId),

    adoptHostProjects: async (hostId, conflicts) => {
      // The host's own projects, read from it: the store cannot hold the
      // one it kept beside the refused one (one project per path).
      try {
        await hostCatalogLifecycle(set, get).read(hostId, (catalog) => {
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
              get,
              workspace.adoptProject(
                state,
                state.settings,
                hostId,
                id,
                keptRow,
              ),
            );
          }
          get().persist();
        });
      } catch (error) {
        console.warn(`Unable to read the catalog of host ${hostId}.`, error);
        return;
      }
      // Its chats, and anything else the host has that this window lacks.
      await get()
        .refreshHostCatalog(hostId)
        .catch((error: unknown) => {
          console.warn(
            `Unable to reload the catalog of host ${hostId}.`,
            error,
          );
        });
    },

    setHostTurnRunning: (chatId, running) => {
      const current = get().hostRunningChatIds;
      if (Boolean(current[chatId]) === running) return;
      const next = { ...current };
      if (running) next[chatId] = true;
      else delete next[chatId];
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
    },

    setHostChatAwaitingApproval: (chatId, awaiting) => {
      const current = get().hostAwaitingApprovalChatIds;
      if (Boolean(current[chatId]) === awaiting) return;
      const next = { ...current };
      if (awaiting) next[chatId] = true;
      else delete next[chatId];
      set({ hostAwaitingApprovalChatIds: next });
    },

    loadHostCatalog: (hostId) =>
      hostCatalogLifecycle(set, get).read(hostId, (catalog) => {
        const state = get();
        void commitWorkspaceRemoval(
          set,
          get,
          workspace.loadHostCatalog(state, state.settings, hostId, {
            catalog,
            workspaceProjects: getLoadedWorkspace().workspaceProjects,
          }),
        );

        const after = get();
        const onHost = (project: ProjectConfig) =>
          getProjectHostId(project) === hostId;
        const hostProjectIds = new Set(
          [...after.projects, ...after.closedProjects]
            .filter(onHost)
            .map((project) => project.id),
        );
        getCatalogSync(hostId).reset({
          chats: after.chats.filter((chat) =>
            hostProjectIds.has(chat.projectId),
          ),
          closedProjects: after.closedProjects.filter(onHost),
          projects: after.projects.filter(onHost),
        });
        markHostLoaded(hostId);
        setRunning(hostId, catalog);
      }),

    reloadCatalog: async (hostId = LOCAL_HOST_ID) => {
      if (!get().stateHydrated) return;
      await hostCatalogLifecycle(set, get).read(hostId, (catalog) => {
        setRunning(hostId, catalog);
        const state = get();
        const sync = getCatalogSync(hostId);
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
    },
  };
};
