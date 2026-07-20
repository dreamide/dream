import { getDesktopApi } from "@/lib/electron";
import {
  createProjectTerminalSessionId,
  getBrowserTerminalSessionId,
} from "../ide-types";
import {
  getDefaultTerminalSessionName,
  getTerminalOrdinalFromName,
  moveItem,
  updateProjectUiInList,
} from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

export const createTerminalActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "startRunner"
  | "stopRunner"
  | "openProjectTerminal"
  | "setProjectTerminalPanelOpen"
  | "addProjectTerminal"
  | "setActiveProjectTerminalId"
  | "reorderProjectTerminals"
  | "closeProjectTerminal"
> => ({
  startRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;
    const sessionId = getBrowserTerminalSessionId(project.id);

    set((state) => ({
      outputPanelOpen: true,
      browserError: null,
      terminalOutput: { ...state.terminalOutput, [sessionId]: "" },
    }));

    await desktopApi.startTerminal({
      command: project.runCommand,
      cwd: project.path,
      projectId: sessionId,
      shellPath: get().settings.shellPath || undefined,
    });
  },

  stopRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;
    const sessionId = getBrowserTerminalSessionId(project.id);

    set((state) => ({
      outputPanelOpen: false,
      terminalOutput: { ...state.terminalOutput, [sessionId]: "" },
      terminalStatus: { ...state.terminalStatus, [sessionId]: "stopped" },
    }));

    await desktopApi.stopTerminal(sessionId);
  },

  openProjectTerminal: async (projectId) => {
    const existingSessionIds = get().projectTerminalSessionIds[projectId] ?? [];

    if (existingSessionIds.length > 0) {
      const activeSessionId =
        get().activeTerminalSessionIdByProject[projectId] ??
        existingSessionIds[existingSessionIds.length - 1] ??
        null;

      set((state) => ({
        activeProjectId: projectId,
        activeTerminalSessionIdByProject: {
          ...state.activeTerminalSessionIdByProject,
          [projectId]: activeSessionId,
        },
        projectTerminalPanelOpenByProject: {
          ...state.projectTerminalPanelOpenByProject,
          [projectId]: true,
        },
      }));
      return;
    }

    await get().addProjectTerminal(projectId);
  },

  setProjectTerminalPanelOpen: (projectId, open) => {
    set((state) => ({
      projectTerminalPanelOpenByProject: {
        ...state.projectTerminalPanelOpenByProject,
        [projectId]: open,
      },
    }));
  },

  addProjectTerminal: async (projectId) => {
    const { projects, settings } = get();
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const sessionId = createProjectTerminalSessionId(projectId);

    set((state) => {
      const existingSessionIds =
        state.projectTerminalSessionIds[projectId] ?? [];
      const highestNamedOrdinal = existingSessionIds.reduce(
        (maxOrdinal, existingSessionId) => {
          const name = state.terminalSessionNames[existingSessionId] ?? "";
          const ordinal = getTerminalOrdinalFromName(name);
          return ordinal ? Math.max(maxOrdinal, ordinal) : maxOrdinal;
        },
        0,
      );
      const existingOrdinal = Math.max(
        state.nextTerminalOrdinalByProject[projectId] ?? 0,
        highestNamedOrdinal,
      );
      const nextOrdinal = existingOrdinal + 1;

      return {
        activeProjectId: projectId,
        projectTerminalSessionIds: {
          ...state.projectTerminalSessionIds,
          [projectId]: [
            ...(state.projectTerminalSessionIds[projectId] ?? []),
            sessionId,
          ],
        },
        activeTerminalSessionIdByProject: {
          ...state.activeTerminalSessionIdByProject,
          [projectId]: sessionId,
        },
        projectTerminalPanelOpenByProject: {
          ...state.projectTerminalPanelOpenByProject,
          [projectId]: true,
        },
        terminalOutput: {
          ...state.terminalOutput,
          [sessionId]: "",
        },
        terminalSessionNames: {
          ...state.terminalSessionNames,
          [sessionId]: getDefaultTerminalSessionName(nextOrdinal),
        },
        terminalStatus: {
          ...state.terminalStatus,
          [sessionId]: "running",
        },
        nextTerminalOrdinalByProject: {
          ...state.nextTerminalOrdinalByProject,
          [projectId]: nextOrdinal,
        },
      };
    });

    await desktopApi.startTerminal({
      cwd: project.path,
      projectId: sessionId,
      shellPath: settings.shellPath || undefined,
    });
  },

  setActiveProjectTerminalId: (projectId, sessionId) => {
    set((state) => {
      const sessionIds = state.projectTerminalSessionIds[projectId] ?? [];
      const nextSessionId =
        sessionId && sessionIds.includes(sessionId)
          ? sessionId
          : (sessionIds[0] ?? null);

      return {
        activeTerminalSessionIdByProject: {
          ...state.activeTerminalSessionIdByProject,
          [projectId]: nextSessionId,
        },
      };
    });
  },

  reorderProjectTerminals: (projectId, fromIndex, toIndex) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const sessionIds =
        state.projectTerminalSessionIds[normalizedProjectId] ?? [];
      const nextSessionIds = moveItem(sessionIds, fromIndex, toIndex);
      if (nextSessionIds === sessionIds) {
        return state;
      }

      return {
        projectTerminalSessionIds: {
          ...state.projectTerminalSessionIds,
          [normalizedProjectId]: nextSessionIds,
        },
      };
    });
  },

  closeProjectTerminal: async (projectId, sessionId) => {
    set((state) => {
      const currentSessionIds =
        state.projectTerminalSessionIds[projectId] ?? [];
      if (!currentSessionIds.includes(sessionId)) {
        return state;
      }

      const nextSessionIds = currentSessionIds.filter((id) => id !== sessionId);
      const activeSessionId =
        state.activeTerminalSessionIdByProject[projectId] ?? null;
      const nextActiveSessionId =
        activeSessionId === sessionId
          ? (nextSessionIds.at(-1) ?? null)
          : activeSessionId;
      const nextTerminalOutput = { ...state.terminalOutput };
      const nextTerminalStatus = { ...state.terminalStatus };
      const nextTerminalTransport = { ...state.terminalTransport };
      const nextTerminalShell = { ...state.terminalShell };
      const nextTerminalSessionNames = { ...state.terminalSessionNames };
      const nextProjectTerminalPanelOpenByProject = {
        ...state.projectTerminalPanelOpenByProject,
      };

      delete nextTerminalOutput[sessionId];
      delete nextTerminalStatus[sessionId];
      delete nextTerminalTransport[sessionId];
      delete nextTerminalShell[sessionId];
      delete nextTerminalSessionNames[sessionId];
      const nextState: Partial<IdeState> = {
        terminalOutput: nextTerminalOutput,
        terminalStatus: nextTerminalStatus,
        terminalTransport: nextTerminalTransport,
        terminalShell: nextTerminalShell,
        terminalSessionNames: nextTerminalSessionNames,
        projectTerminalSessionIds: {
          ...state.projectTerminalSessionIds,
          [projectId]: nextSessionIds,
        },
        activeTerminalSessionIdByProject: {
          ...state.activeTerminalSessionIdByProject,
          [projectId]: nextActiveSessionId,
        },
      };

      if (nextSessionIds.length === 0) {
        nextProjectTerminalPanelOpenByProject[projectId] = false;
        nextState.projects = updateProjectUiInList(
          state.projects,
          projectId,
          (project) => ({
            ...project.ui,
            rightPanelOpen:
              project.ui.rightPanelView === "terminal"
                ? false
                : project.ui.rightPanelOpen,
          }),
        );
        nextState.closedProjects = updateProjectUiInList(
          state.closedProjects,
          projectId,
          (project) => ({
            ...project.ui,
            rightPanelOpen:
              project.ui.rightPanelView === "terminal"
                ? false
                : project.ui.rightPanelOpen,
          }),
        );
      }
      nextState.projectTerminalPanelOpenByProject =
        nextProjectTerminalPanelOpenByProject;

      return nextState;
    });

    const desktopApi = getDesktopApi();
    if (desktopApi) {
      await desktopApi.stopTerminal(sessionId);
    }
  },
});
