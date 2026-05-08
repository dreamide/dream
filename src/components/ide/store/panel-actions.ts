import type { ProjectConfig } from "@/types/ide";
import { updateProjectUiInList } from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

export const createPanelActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "togglePanel"
  | "setPanelSizes"
  | "setProjectPanelSizes"
  | "setProjectChatHistoryPanelOpen"
  | "setProjectRightPanelOpen"
  | "setProjectRightPanelView"
  | "openProjectFile"
  | "setOutputPanelOpen"
  | "setClaudePermissionMode"
  | "setCodexPermissionMode"
> => ({
  togglePanel: (panel) => {
    if (panel === "middle") {
      return;
    }

    set((state) => {
      if (panel === "left") {
        const projectId = state.activeProjectId;
        const project = state.projects.find((item) => item.id === projectId);
        const currentOpen = project?.ui.chatHistoryPanelOpen ?? false;
        const nextOpen = !currentOpen;

        return {
          projects: projectId
            ? updateProjectUiInList(state.projects, projectId, (item) => ({
                ...item.ui,
                chatHistoryPanelOpen: nextOpen,
              }))
            : state.projects,
        };
      }

      const projectId = state.activeProjectId;
      const project = state.projects.find((item) => item.id === projectId);
      const currentOpen = project?.ui.rightPanelOpen ?? false;
      const nextOpen = !currentOpen;

      return {
        projects: projectId
          ? updateProjectUiInList(state.projects, projectId, (item) => ({
              ...item.ui,
              rightPanelOpen: nextOpen,
            }))
          : state.projects,
      };
    });
  },

  setPanelSizes: (updater) => {
    set((state) => {
      const projectId = state.activeProjectId;
      const project = state.projects.find((item) => item.id === projectId);
      if (!projectId || !project) {
        return state;
      }
      const panelSizes =
        typeof updater === "function"
          ? updater(project.ui.panelSizes)
          : updater;

      return {
        projects: updateProjectUiInList(state.projects, projectId, (item) => ({
          ...item.ui,
          panelSizes,
        })),
      };
    });
  },

  setProjectPanelSizes: (projectId, updater) => {
    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }
      const panelSizes =
        typeof updater === "function"
          ? updater(project.ui.panelSizes)
          : updater;

      return {
        projects: updateProjectUiInList(state.projects, projectId, (item) => ({
          ...item.ui,
          panelSizes,
        })),
      };
    });
  },

  setProjectChatHistoryPanelOpen: (projectId, open) => {
    set((state) => ({
      projects: updateProjectUiInList(state.projects, projectId, (project) => ({
        ...project.ui,
        chatHistoryPanelOpen: open,
      })),
    }));
  },

  setProjectRightPanelOpen: (projectId, open) => {
    set((state) => {
      const shouldUpdateProjects = state.projects.some(
        (project) =>
          project.id === projectId && project.ui.rightPanelOpen !== open,
      );
      const shouldUpdateClosedProjects = state.closedProjects.some(
        (project) =>
          project.id === projectId && project.ui.rightPanelOpen !== open,
      );

      if (!shouldUpdateProjects && !shouldUpdateClosedProjects) {
        return state;
      }

      const projectUpdater = (project: ProjectConfig) => ({
        ...project.ui,
        rightPanelOpen: open,
      });
      const nextState: Partial<IdeState> = {};

      if (shouldUpdateProjects) {
        nextState.projects = updateProjectUiInList(
          state.projects,
          projectId,
          projectUpdater,
        );
      }

      if (shouldUpdateClosedProjects) {
        nextState.closedProjects = updateProjectUiInList(
          state.closedProjects,
          projectId,
          projectUpdater,
        );
      }

      return Object.keys(nextState).length > 0 ? nextState : state;
    });
  },

  setProjectRightPanelView: (projectId, view) => {
    set((state) => {
      const shouldUpdateProjects = state.projects.some(
        (project) =>
          project.id === projectId && project.ui.rightPanelView !== view,
      );
      const shouldUpdateClosedProjects = state.closedProjects.some(
        (project) =>
          project.id === projectId && project.ui.rightPanelView !== view,
      );

      if (!shouldUpdateProjects && !shouldUpdateClosedProjects) {
        return state;
      }

      const projectUpdater = (project: ProjectConfig) => ({
        ...project.ui,
        rightPanelView: view,
      });
      const nextState: Partial<IdeState> = {};

      if (shouldUpdateProjects) {
        nextState.projects = updateProjectUiInList(
          state.projects,
          projectId,
          projectUpdater,
        );
      }

      if (shouldUpdateClosedProjects) {
        nextState.closedProjects = updateProjectUiInList(
          state.closedProjects,
          projectId,
          projectUpdater,
        );
      }

      return Object.keys(nextState).length > 0 ? nextState : state;
    });
  },

  openProjectFile: (projectId, filePath) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedFilePath =
      typeof filePath === "string" ? filePath.trim() : "";
    if (!normalizedProjectId || !normalizedFilePath) {
      return;
    }

    let shouldPersist = false;

    set((state) => {
      if (
        !state.projects.some((project) => project.id === normalizedProjectId)
      ) {
        return state;
      }

      const currentRequest = state.projectFileOpenRequests[normalizedProjectId];

      shouldPersist = true;

      return {
        projectFileOpenRequests: {
          ...state.projectFileOpenRequests,
          [normalizedProjectId]: {
            filePath: normalizedFilePath,
            requestId: (currentRequest?.requestId ?? 0) + 1,
          },
        },
        projects: updateProjectUiInList(
          state.projects,
          normalizedProjectId,
          (project) => ({
            ...project.ui,
            rightPanelOpen: true,
            rightPanelView: "explorer",
          }),
        ),
      };
    });

    if (shouldPersist) {
      get().persist();
    }
  },

  setOutputPanelOpen: (open) => set({ outputPanelOpen: open }),
  setClaudePermissionMode: (value) => set({ claudePermissionMode: value }),
  setCodexPermissionMode: (value) => set({ codexPermissionMode: value }),
});
