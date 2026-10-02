// Opening, closing and switching projects. The document operations live in
// workspace-document.ts; these wrappers add what is runtime-only (terminal
// sessions, the per-project runtime maps, the "finished while away" marks).
import { getDesktopApi } from "@/lib/electron";
import { terminalClient } from "@/lib/terminal-client";
import type { ProjectConfig, ProjectWorktreeInfo } from "@/types/ide";
import { deleteTerminalScrollback } from "../terminal-scrollback";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { dropProjectRuntimeState } from "./project-runtime-state";
import * as workspace from "./workspace-document";

export const createProjectLifecycleActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "setProjects"
  | "setActiveProjectId"
  | "addProject"
  | "closeProject"
  | "stopProjectTerminals"
  | "updateProject"
> => ({
  setProjects: (projects: ProjectConfig[]) => {
    set((state) => workspace.setProjects(state, state.settings, projects));
  },

  setActiveProjectId: (id: string | null) => {
    set((state) => {
      const next = workspace.activateProject(state, id);
      // Chats that finished while the user was elsewhere lose their mark
      // once their project is in front.
      const completedChatIds = { ...state.completedChatIds };
      let marksCleared = false;
      if (next.activeProjectId) {
        for (const chat of state.chats) {
          if (
            chat.projectId === next.activeProjectId &&
            completedChatIds[chat.id]
          ) {
            delete completedChatIds[chat.id];
            marksCleared = true;
          }
        }
      }
      if (next.activeProjectId === state.activeProjectId && !marksCleared) {
        return state;
      }
      return marksCleared ? { ...next, completedChatIds } : next;
    });
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

  stopProjectTerminals: (projectId: string) => {
    const terminalSessionIds =
      get().projectTerminalSessionIds?.[projectId] ?? [];
    const desktopApi = getDesktopApi();
    for (const sessionId of terminalSessionIds) {
      if (desktopApi) void terminalClient.stop(sessionId);
      deleteTerminalScrollback(sessionId);
    }
  },

  closeProject: (projectId: string) => {
    get().stopProjectTerminals(projectId);
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
