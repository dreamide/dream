import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig, ProjectWorktreeInfo } from "@/types/ide";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { createHostReach, type HostReach } from "./host-reach";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import {
  commitWorkspaceRemoval,
  dropProjectRuntimeState,
} from "./project-runtime-state";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";
import * as workspace from "./workspace-document";

export const createProjectLifecycleActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  terminals: TerminalSessionOwner = createTerminalSessionOwner(set, get),
  hosts: Pick<HostReach, "reach"> = createHostReach(get),
): Pick<
  IdeState,
  | "setProjects"
  | "setActiveProjectId"
  | "addProject"
  | "openProject"
  | "closeProject"
  | "forgetClosedProject"
  | "stopProjectTerminals"
  | "updateProject"
> => ({
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

  stopProjectTerminals: (projectId: string) => terminals.dropProject(projectId),

  closeProject: (projectId: string) => {
    void get().stopProjectTerminals(projectId);
    set((state) => {
      const runtime = dropProjectRuntimeState(state, projectId);
      return {
        ...runtime,
        ...workspace.closeProject(
          { ...state, ...runtime },
          state.settings,
          projectId,
        ),
      };
    });
  },

  forgetClosedProject: (projectId: string) => {
    if (!get().closedProjects.some((project) => project.id === projectId)) {
      return;
    }
    const state = get();
    void commitWorkspaceRemoval(
      set,
      get,
      workspace.removeProjects(state, state.settings, [projectId]),
    );
    // Its host's catalog hears of the removal with the next save.
    get().persist();
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
