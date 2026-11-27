import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { getHostSocketClient, type HostSocketClient } from "@/lib/host-socket";
import { type TerminalClient, terminalClient } from "@/lib/terminal-client";
import type {
  ProjectConfig,
  TerminalDataEvent,
  TerminalStatusEvent,
} from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import {
  createProjectTerminalSessionId,
  getBrowserTerminalSessionId,
  PROJECT_TERMINAL_SESSION_PREFIX,
} from "../ide-types";
import {
  deleteTerminalScrollback,
  hasTerminalScrollback,
  publishTerminalOutput,
  resetTerminalScrollback,
} from "../terminal-scrollback";
import {
  type createTerminalSessions,
  terminalSessions,
} from "../terminal-session";
import { isTerminalSessionUntouched } from "../terminal-untouched";
import {
  getDefaultTerminalSessionName,
  getTerminalOrdinalFromName,
  moveItem,
  updateProjectUiInList,
} from "./helpers";
import type {
  AddProjectTerminalOptions,
  CloseProjectTerminalOptions,
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
} from "./ide-store-types";

type TerminalStoreSet = (
  update: Partial<IdeState> | ((state: IdeState) => Partial<IdeState>),
) => void;

export interface TerminalSessionOwnerParts {
  /** The shells on their Hosts. */
  client?: Pick<TerminalClient, "acknowledge" | "sendInput" | "start" | "stop">;
  /** Command observation and the untouched mark (terminal-session.ts). */
  observation?: ReturnType<typeof createTerminalSessions>;
  /** A desktop attached to a home host it did not start. */
  isDetached?: () => boolean;
  /** The local Host's socket, which answers discovery. */
  localHostSocket?: () => Pick<HostSocketClient, "send">;
}

/**
 * The Terminal session owner. A session's state is in four places: what
 * panels render is in the store (its Project's session list and active
 * session, its name, status, transport and shell, the Project's next
 * ordinal); its output buffer (terminal-scrollback.ts), its command
 * observation and untouched mark (terminal-session.ts) are bookkeeping no
 * panel subscribes to; its shell is on its Host, through the terminal
 * client. Each operation here changes all of them, in one order, and no
 * other code changes them. A Project's store maps leave with its runtime
 * state (project-runtime-state.ts) in the same close or removal.
 */
export const createTerminalSessionOwner = (
  set: TerminalStoreSet,
  get: () => IdeState,
  {
    client = terminalClient,
    observation = terminalSessions,
    isDetached = () => getDesktopApi()?.hostMode === "detached",
    localHostSocket = () => getHostSocketClient(LOCAL_HOST_ID),
  }: TerminalSessionOwnerParts = {},
) => {
  const close = async (
    projectId: string,
    sessionId: string,
    options: CloseProjectTerminalOptions = {},
  ) => {
    observation.close(sessionId);
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

    await client.stop(sessionId);
  };

  /**
   * A running shell on a detached home host that this window does not know:
   * it outlived the desktop that started it, and joins its local Project.
   */
  const restore = (sessionId: string) => {
    const project = get().projects.find(
      (project) =>
        getProjectHostId(project) === LOCAL_HOST_ID &&
        (sessionId.startsWith(
          `${PROJECT_TERMINAL_SESSION_PREFIX}${project.id}:`,
        ) ||
          sessionId === getBrowserTerminalSessionId(project.id)),
    );
    if (!project) return;
    observation.open(sessionId, project.id);
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
  };

  return {
    /** Starts a shell in a Project; one that fails to start is closed. */
    open: async (
      projectId: string,
      options: AddProjectTerminalOptions = {},
    ) => {
      const { projects, settings } = get();
      const project = projects.find((item) => item.id === projectId);
      if (!project) return;

      const sessionId = createProjectTerminalSessionId(projectId);
      resetTerminalScrollback(sessionId);
      observation.open(sessionId, projectId, options.closeIfUntouched);

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
              options.name?.trim() ||
              getDefaultTerminalSessionName(nextOrdinal),
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
        const result = await client.start({
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
        await close(projectId, sessionId);
        throw error;
      }
    },

    /** Settles its pending command, forgets it and stops its shell. */
    close,

    /**
     * Terminals started just by showing the terminal view are discarded when
     * it stops showing, unless the user typed something into them.
     */
    discardUntouched: (projectId: string) => {
      const untouchedSessionIds = (
        get().projectTerminalSessionIds[projectId] ?? []
      ).filter(isTerminalSessionUntouched);
      for (const sessionId of untouchedSessionIds) {
        void close(projectId, sessionId, { keepRightPanelOpen: true });
      }
    },

    /** Starts a Project's run command in its browser panel's terminal. */
    startRunner: async (project: ProjectConfig) => {
      const sessionId = getBrowserTerminalSessionId(project.id);
      observation.open(sessionId, project.id);
      resetTerminalScrollback(sessionId);

      set({
        outputPanelOpen: true,
      });

      await client.start({
        command: project.runCommand,
        cwd: project.path,
        sessionId,
        shellPath: get().settings.shellPath || undefined,
      });
    },

    stopRunner: async (project: ProjectConfig) => {
      const sessionId = getBrowserTerminalSessionId(project.id);
      observation.close(sessionId);
      resetTerminalScrollback(sessionId);

      set((state) => ({
        outputPanelOpen: false,
        terminalStatus: { ...state.terminalStatus, [sessionId]: "stopped" },
      }));

      await client.stop(sessionId);
    },

    /** What the person typed, for the shell and for command observation. */
    input: (sessionId: string, data: string) => {
      observation.input(sessionId, data);
      client.sendInput({ data, sessionId });
    },

    /**
     * A Project is closing or leaving the workspace: its pending command is
     * cancelled, its output dropped and its shells stopped. A stop that fails
     * (its Host is gone) is logged, never thrown.
     */
    dropProject: async (projectId: string) => {
      observation.closeProject(projectId);
      const sessionIds = get().projectTerminalSessionIds?.[projectId] ?? [];
      const stops = sessionIds.map(async (sessionId) => {
        deleteTerminalScrollback(sessionId);
        try {
          await client.stop(sessionId);
        } catch (error) {
          // The host may be gone; nothing here can stop the shell then.
          console.warn(`Unable to stop terminal ${sessionId}.`, error);
        }
      });
      await Promise.all(stops);
    },

    /**
     * A Host is being removed with these Projects: their pending commands
     * are cancelled and their output dropped at once, whether or not the
     * Host can still be asked to stop the shells (`dropProject` asks).
     */
    dropHost: (projectIds: readonly string[]) => {
      for (const projectId of projectIds) {
        observation.closeProject(projectId);
        for (const sessionId of get().projectTerminalSessionIds?.[projectId] ??
          []) {
          deleteTerminalScrollback(sessionId);
        }
      }
    },

    /**
     * Output from a Host: it feeds command observation and the views, and is
     * acknowledged by generation and sequence once every view processed it.
     */
    receiveOutput: (event: TerminalDataEvent) => {
      const { generation, sequence, sessionId } = event;
      observation.output(sessionId);
      publishTerminalOutput(sessionId, event.chunk, () => {
        if (generation !== undefined && sequence !== undefined) {
          client.acknowledge({ sessionId, generation, sequence });
        }
      });
    },

    /**
     * A session's status from a Host. A detached home host's running shell
     * this window does not know is restored first; a session still unknown
     * here is ignored.
     */
    receiveStatus: (event: TerminalStatusEvent) => {
      const { sessionId } = event;
      if (
        isDetached() &&
        event.status === "running" &&
        !hasTerminalScrollback(sessionId)
      ) {
        restore(sessionId);
      }
      if (!hasTerminalScrollback(sessionId)) return;
      const shell = typeof event.shell === "string" ? event.shell.trim() : "";
      const { transport } = event;
      set((state) => ({
        terminalStatus: { ...state.terminalStatus, [sessionId]: event.status },
        ...(transport
          ? {
              terminalTransport: {
                ...state.terminalTransport,
                [sessionId]: transport,
              },
            }
          : {}),
        ...(shell
          ? { terminalShell: { ...state.terminalShell, [sessionId]: shell } }
          : {}),
      }));
    },

    /**
     * A fresh desktop on a detached home host asks it which terminals
     * survived, once the workspace is hydrated and again whenever its
     * Projects change; the answers arrive as statuses (`receiveStatus`), so
     * only sessions of known Projects are restored. Returns the unsubscribe.
     */
    followDiscovery: (subscribe: (listener: () => void) => () => void) => {
      if (!isDetached()) return () => {};
      let known = "";
      const discover = () => {
        const state = get();
        if (!state.stateHydrated) return;
        const key = JSON.stringify(state.projects.map((project) => project.id));
        if (key === known) return;
        known = key;
        localHostSocket().send({ channel: "terminal", type: "discover" });
      };
      discover();
      return subscribe(discover);
    },

    /** What refreshes a Project after a command in its terminal settles. */
    setRefreshProject: (refreshProject: (projectId: string) => void) => {
      observation.setRefreshProject(refreshProject);
    },
  };
};

export type TerminalSessionOwner = ReturnType<
  typeof createTerminalSessionOwner
>;

/** The terminal actions in the store (`IdeState`). */
export interface TerminalActions {
  startRunner: () => Promise<void>;
  stopRunner: () => Promise<void>;
  openProjectTerminal: (projectId: string) => Promise<void>;
  addProjectTerminal: (
    projectId: string,
    options?: AddProjectTerminalOptions,
  ) => Promise<void>;
  setActiveProjectTerminalId: (
    projectId: string,
    sessionId: string | null,
  ) => void;
  reorderProjectTerminals: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  closeProjectTerminal: (
    projectId: string,
    sessionId: string,
    options?: CloseProjectTerminalOptions,
  ) => Promise<void>;
}

export const createTerminalActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  terminals: TerminalSessionOwner = createTerminalSessionOwner(set, get),
): TerminalActions => ({
  startRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;
    await terminals.startRunner(project);
  },

  stopRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;
    await terminals.stopRunner(project);
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

  addProjectTerminal: (projectId, options) =>
    terminals.open(projectId, options),

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

  closeProjectTerminal: (projectId, sessionId, options) =>
    terminals.close(projectId, sessionId, options),
});
