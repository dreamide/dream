import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig, ProjectWorktreeInfo } from "@/types/ide";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { createHostReach, type HostReach } from "./host-reach";
import type { IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { commitWorkspaceRemoval } from "./project-runtime-state";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";
import * as workspace from "./workspace-document";

/** The project actions in the store (`IdeState`). */
export interface ProjectLifecycleActions {
  setProjects: (projects: ProjectConfig[]) => void;
  setActiveProjectId: (id: string | null) => void;
  addProject: (
    path: string,
    options?: {
      activate?: boolean;
      /** The host the folder is on; the local host when absent. */
      hostId?: string;
      /**
       * Marks the project as a Git worktree. Only fills in projects that do
       * not already carry worktree info, so details recorded at creation
       * (base branch, creation time) are kept.
       */
      worktree?: ProjectWorktreeInfo;
    },
  ) => void;
  /**
   * Opens the folder at `path` on a host as a project, the way a person
   * opens one: an SSH host is connected first (ssh's prompts appear in
   * their own dialog), so a project already there opens as itself. False
   * when the host could not be reached; nothing is added then.
   */
  openProject: (
    path: string,
    options?: { activate?: boolean; hostId?: string; signal?: AbortSignal },
  ) => Promise<boolean>;
  closeProject: (projectId: string) => void;
  /**
   * Removes a closed project for good, with its chats: from this window and
   * from its host's catalog. Its folder is not touched.
   */
  forgetClosedProject: (projectId: string) => void;
  updateProject: (
    projectId: string,
    updater: (project: ProjectConfig) => ProjectConfig,
  ) => void;
}

export const createProjectLifecycleActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  {
    terminals = createTerminalSessionOwner(set, get),
    hosts = createHostReach(get),
    persist,
  }: {
    /** The Terminal session owner, which stops a Project's terminals. */
    terminals?: Pick<TerminalSessionOwner, "dropProject">;
    /** The Host reach owner, which reaches a Host before opening on it. */
    hosts?: Pick<HostReach, "reach">;
    /** Saves every slice now (the save scheduler in ide-store.ts). */
    persist: () => void;
  },
): ProjectLifecycleActions => ({
  setProjects: (projects: ProjectConfig[]) => {
    set((state) => workspace.setProjects(state, state.settings, projects));
  },

  setActiveProjectId: (id: string | null) => {
    set((state) => {
      const next = workspace.activateProject(state, id);
      return next.activeProjectId === state.activeProjectId ? state : next;
    });
    // Chats that finished while the user was elsewhere lose their mark
    // once their project is in front.
    const { activeProjectId, chats } = get();
    if (activeProjectId)
      chatTurnOutcomes.seen(
        chats
          .filter((chat) => chat.projectId === activeProjectId)
          .map((chat) => chat.id),
      );
  },

  addProject: (
    path: string,
    options?: {
      activate?: boolean;
      hostId?: string;
      worktree?: ProjectWorktreeInfo;
    },
  ) => {
    set(
      (state) =>
        workspace.openProject(state, state.settings, path, {
          activate: options?.activate,
          hostId: options?.hostId,
          worktree: options?.worktree,
        }).doc,
    );
  },

  openProject: async (path, options) => {
    const trimmed = path.trim();
    if (!trimmed || options?.signal?.aborted) return false;
    // The local host is no host at all on a project.
    const hostId =
      options?.hostId === LOCAL_HOST_ID ? undefined : options?.hostId;
    // An SSH host's projects must be here first: one already at this path
    // opens as itself, not as a second project the host would refuse.
    // The home host needs no reaching, so this stays synchronous.
    if (hostId && !(await hosts.reach(hostId))) return false;
    if (options?.signal?.aborted) return false;
    get().addProject(trimmed, { activate: options?.activate, hostId });
    return true;
  },

  closeProject: (projectId: string) => {
    const state = get();
    const doc = workspace.closeProject(state, state.settings, projectId);
    void commitWorkspaceRemoval(
      set,
      terminals,
      workspace.removalBetween(state, doc),
    );
  },

  forgetClosedProject: (projectId: string) => {
    if (!get().closedProjects.some((project) => project.id === projectId)) {
      return;
    }
    const state = get();
    void commitWorkspaceRemoval(
      set,
      terminals,
      workspace.removeProjects(state, state.settings, [projectId]),
    );
    // Its host's catalog hears of the removal with the next save.
    persist();
  },

  updateProject: (
    projectId: string,
    updater: (project: ProjectConfig) => ProjectConfig,
  ) => {
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? updater(project) : project,
      ),
    }));
  },
});
