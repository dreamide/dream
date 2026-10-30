import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { terminalClient } from "@/lib/terminal-client";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import {
  createProjectTerminalSessionId,
  getBrowserTerminalSessionId,
  PROJECT_TERMINAL_SESSION_PREFIX,
} from "../ide-types";
import {
  deleteTerminalScrollback,
  hasTerminalScrollback,
  resetTerminalScrollback,
} from "../terminal-scrollback";
import { terminalSessions } from "../terminal-session";
import { isTerminalSessionUntouched } from "../terminal-untouched";
import {
  getDefaultTerminalSessionName,
  getTerminalOrdinalFromName,
  moveItem,
  updateProjectUiInList,
} from "./helpers";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

export const createTerminalActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "startRunner"
  | "stopRunner"
  | "openProjectTerminal"
  | "discardUntouchedTerminals"
  | "addProjectTerminal"
  | "setActiveProjectTerminalId"
  | "reorderProjectTerminals"
  | "closeProjectTerminal"
  | "restoreHostTerminal"
> => ({
  restoreHostTerminal: (sessionId) => {
    const project = get().projects.find(
      (project) =>
        getProjectHostId(project) === LOCAL_HOST_ID &&
        (sessionId.startsWith(
          `${PROJECT_TERMINAL_SESSION_PREFIX}${project.id}:`,
        ) ||
          sessionId === getBrowserTerminalSessionId(project.id)),
    );
    if (!project) return;
    terminalSessions.open(sessionId, project.id);
    if (!hasTerminalScrollback(sessionId)) resetTerminalScrollback(sessionId);
    if (sessionId === getBrowserTerminalSessionId(project.id)) return;
    set((state) => {
      const ids = state.projectTerminalSessionIds[project.id] ?? [];
      if (ids.includes(sessionId)) return {};
      const ordinal = (state.nextTerminalOrdinalByProject[project.id] ?? 0) + 1;
      return {
        projectTerminalSessionIds: {
          ...state.projectTerminalSessionIds,
          [project.id]: [...ids, sessionId],
        },
        activeTerminalSessionIdByProject: {
          ...state.activeTerminalSessionIdByProject,
          [project.id]:
            state.activeTerminalSessionIdByProject[project.id] ?? sessionId,
        },
        terminalSessionNames: {
          ...state.terminalSessionNames,
          [sessionId]: getDefaultTerminalSessionName(ordinal),
        },
        nextTerminalOrdinalByProject: {
          ...state.nextTerminalOrdinalByProject,
          [project.id]: ordinal,
        },
      };
    });
  },
  startRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;

    const sessionId = getBrowserTerminalSessionId(project.id);
    terminalSessions.open(sessionId, project.id);
    resetTerminalScrollback(sessionId);

    set({
      outputPanelOpen: true,
      browserError: null,
    });

    await terminalClient.start({
      command: project.runCommand,
      cwd: project.path,
      sessionId,
      shellPath: get().settings.shellPath || undefined,
    });
  },

  stopRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;

    const sessionId = getBrowserTerminalSessionId(project.id);
    terminalSessions.close(sessionId);
    resetTerminalScrollback(sessionId);

    set((state) => ({
      outputPanelOpen: false,
      terminalStatus: { ...state.terminalStatus, [sessionId]: "stopped" },
    }));

    await terminalClient.stop(sessionId);
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
      }));
      return;
    }

    await get().addProjectTerminal(projectId, { closeIfUntouched: true });
  },

  discardUntouchedTerminals: (projectId) => {
    // Terminals started just by showing the terminal view are discarded when
    // it stops showing, unless the user typed something into them.
    const untouchedSessionIds = (
      get().projectTerminalSessionIds[projectId] ?? []
    ).filter(isTerminalSessionUntouched);
    for (const sessionId of untouchedSessionIds) {
      void get().closeProjectTerminal(projectId, sessionId, {
        keepRightPanelOpen: true,
      });
    }
  },

  addProjectTerminal: async (projectId, options = {}) => {
    const { projects, settings } = get();
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;

    const sessionId = createProjectTerminalSessionId(projectId);
    resetTerminalScrollback(sessionId);
    terminalSessions.open(sessionId, projectId, options.closeIfUntouched);

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
        terminalSessionNames: {
          ...state.terminalSessionNames,
          [sessionId]:
            options.name?.trim() || getDefaultTerminalSessionName(nextOrdinal),
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

    try {
      const result = await terminalClient.start({
        command: options.command,
        cwd: options.cwd?.trim() || project.path,
        sessionId,
        shellPath: settings.shellPath || undefined,
        strictCwd: options.strictCwd,
      });

      if (result.status !== "running") {
        throw new Error("Terminal failed to start.");
      }
    } catch (error) {
      await get().closeProjectTerminal(projectId, sessionId);
      throw error;
    }
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

  closeProjectTerminal: async (projectId, sessionId, options = {}) => {
    terminalSessions.close(sessionId);
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
      const nextTerminalStatus = { ...state.terminalStatus };
      const nextTerminalTransport = { ...state.terminalTransport };
      const nextTerminalShell = { ...state.terminalShell };
      const nextTerminalSessionNames = { ...state.terminalSessionNames };

      delete nextTerminalStatus[sessionId];
      delete nextTerminalTransport[sessionId];
      delete nextTerminalShell[sessionId];
      delete nextTerminalSessionNames[sessionId];
      const nextState: Partial<IdeState> = {
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

      if (nextSessionIds.length === 0 && !options.keepRightPanelOpen) {
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

      return nextState;
    });
    deleteTerminalScrollback(sessionId);

    await terminalClient.stop(sessionId);
  },
});
