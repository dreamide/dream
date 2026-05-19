import { getDesktopApi } from "@/lib/electron";
import {
  createChatConfig,
  createProjectConfig,
  getDefaultModelSelection,
} from "@/lib/ide-defaults";
import type {
  ProjectConfig,
  ProjectGitCreateWorktreeResponse,
} from "@/types/ide";
import {
  ensureActiveChatForProject,
  ensureActiveProject,
  normalizeProjectPathKey,
  sanitizeProjectUiForChats,
} from "../ide-state";
import { updateProjectUiInList } from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

export const createProjectLifecycleActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "setProjects"
  | "setActiveProjectId"
  | "addProject"
  | "createWorktreeProject"
  | "closeProject"
  | "updateProject"
> => ({
  setProjects: (projects: ProjectConfig[]) => {
    set((state) => {
      const nextActiveProjectId =
        state.activeProjectId === null
          ? null
          : ensureActiveProject(projects, state.activeProjectId);
      let nextChats = state.chats;
      let nextMessagesByChatId = state.messagesByChatId;
      const nextProjects = projects.map((project) => {
        let nextActiveChatId = ensureActiveChatForProject(
          nextChats,
          project.id,
          project.ui.activeChatId,
        );

        if (!nextActiveChatId) {
          const defaultSelection = getDefaultModelSelection(state.settings);
          const nextChat = createChatConfig(project, {
            model: defaultSelection.model || project.model,
            provider: defaultSelection.model
              ? defaultSelection.provider
              : project.provider,
          });
          nextChats = [...nextChats, nextChat];
          nextMessagesByChatId = {
            ...nextMessagesByChatId,
            [nextChat.id]: [],
          };
          nextActiveChatId = nextChat.id;
        }

        return {
          ...project,
          ui: sanitizeProjectUiForChats(
            nextChats,
            project.id,
            project.ui,
            nextActiveChatId,
          ),
        };
      });

      return {
        activeProjectId: nextActiveProjectId,
        chats: nextChats,
        messagesByChatId: nextMessagesByChatId,
        projects: nextProjects,
      };
    });
  },

  setActiveProjectId: (id: string | null) => {
    set((state) => {
      if (id === null) {
        return state.activeProjectId === null
          ? state
          : {
              activeProjectId: null,
            };
      }

      const nextActiveProjectId = ensureActiveProject(state.projects, id);

      if (nextActiveProjectId === state.activeProjectId) {
        return state;
      }

      return {
        activeProjectId: nextActiveProjectId,
      };
    });
  },

  addProject: (path: string) => {
    set((state) => {
      const pathKey = normalizeProjectPathKey(path);
      const openProject = state.projects.find(
        (project) => normalizeProjectPathKey(project.path) === pathKey,
      );
      if (openProject) {
        let nextChats = state.chats;
        let nextMessagesByChatId = state.messagesByChatId;
        let nextActiveChatId = ensureActiveChatForProject(
          nextChats,
          openProject.id,
          openProject.ui.activeChatId,
        );

        if (!nextActiveChatId) {
          const defaultSelection = getDefaultModelSelection(state.settings);
          const nextChat = createChatConfig(openProject, {
            model: defaultSelection.model || openProject.model,
            provider: defaultSelection.model
              ? defaultSelection.provider
              : openProject.provider,
          });
          nextChats = [...nextChats, nextChat];
          nextMessagesByChatId = {
            ...nextMessagesByChatId,
            [nextChat.id]: [],
          };
          nextActiveChatId = nextChat.id;
        }
        return {
          activeProjectId: openProject.id,
          chats: nextChats,
          messagesByChatId: nextMessagesByChatId,
          projects: updateProjectUiInList(
            state.projects,
            openProject.id,
            (project) =>
              sanitizeProjectUiForChats(
                nextChats,
                openProject.id,
                project.ui,
                nextActiveChatId,
              ),
          ),
        };
      }

      const closedProject = state.closedProjects.find(
        (project) => normalizeProjectPathKey(project.path) === pathKey,
      );
      if (closedProject) {
        const reopenedProject = { ...closedProject, path };
        let nextChats = state.chats;
        let nextMessagesByChatId = state.messagesByChatId;
        let nextActiveChatId = ensureActiveChatForProject(
          nextChats,
          reopenedProject.id,
          reopenedProject.ui.activeChatId,
        );

        if (!nextActiveChatId) {
          const nextChat = createChatConfig(reopenedProject);
          nextChats = [...nextChats, nextChat];
          nextMessagesByChatId = {
            ...nextMessagesByChatId,
            [nextChat.id]: [],
          };
          nextActiveChatId = nextChat.id;
        }

        return {
          activeProjectId: reopenedProject.id,
          closedProjects: state.closedProjects.filter(
            (project) =>
              normalizeProjectPathKey(project.path) !== pathKey &&
              project.id !== reopenedProject.id,
          ),
          messagesByChatId: nextMessagesByChatId,
          chats: nextChats,
          projects: [
            ...state.projects,
            {
              ...reopenedProject,
              ui: sanitizeProjectUiForChats(
                nextChats,
                reopenedProject.id,
                reopenedProject.ui,
                nextActiveChatId,
              ),
            },
          ],
        };
      }

      const nextProject = createProjectConfig(path, state.settings);
      const nextChat = createChatConfig(nextProject);

      return {
        activeProjectId: nextProject.id,
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [nextProject.id]: nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: [],
        },
        chats: [...state.chats, nextChat],
        projects: [
          ...state.projects,
          {
            ...nextProject,
            ui: {
              ...nextProject.ui,
              activeChatId: nextChat.id,
              openChatIds: [nextChat.id],
              chatColumnWidths: {},
            },
          },
        ],
      };
    });
  },

  createWorktreeProject: async (
    parentProjectId: string,
    options: {
      baseRef?: string | null;
      branchName: string;
    },
  ) => {
    const parentProject = get().projects.find(
      (project) => project.id === parentProjectId,
    );
    if (!parentProject) {
      throw new Error("Parent project is no longer open.");
    }

    const response = await fetch("/api/project-git-worktree-create", {
      body: JSON.stringify({
        baseRef: options.baseRef ?? null,
        branchName: options.branchName,
        projectPath: parentProject.path,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text.trim() || "Unable to create worktree.");
    }

    const payload = (await response.json()) as ProjectGitCreateWorktreeResponse;
    let createdProjectId: string | null = null;

    set((state) => {
      const pathKey = normalizeProjectPathKey(payload.path);
      const existingProject = state.projects.find(
        (project) => normalizeProjectPathKey(project.path) === pathKey,
      );
      if (existingProject) {
        createdProjectId = existingProject.id;
        return {
          activeProjectId: existingProject.id,
        };
      }

      const closedProject = state.closedProjects.find(
        (project) => normalizeProjectPathKey(project.path) === pathKey,
      );
      if (closedProject) {
        createdProjectId = closedProject.id;
        return {
          activeProjectId: closedProject.id,
          closedProjects: state.closedProjects.filter(
            (project) => project.id !== closedProject.id,
          ),
          projects: [
            ...state.projects,
            {
              ...closedProject,
              path: payload.path,
              worktree: {
                baseRef: payload.baseRef,
                branch: payload.branch,
                createdAt: new Date().toISOString(),
                kind: "worktree",
                mainWorktreePath: payload.mainWorktreePath,
                managed: true,
                parentProjectId,
                repoRoot: payload.repoRoot,
              },
            },
          ],
        };
      }

      const nextProject = {
        ...createProjectConfig(payload.path, state.settings),
        browserUrl: parentProject.browserUrl,
        model: parentProject.model,
        modelSpeed: parentProject.modelSpeed,
        name: `${parentProject.name} / ${payload.branch}`,
        provider: parentProject.provider,
        reasoningEffort: parentProject.reasoningEffort,
        runCommand: parentProject.runCommand,
        worktree: {
          baseRef: payload.baseRef,
          branch: payload.branch,
          createdAt: new Date().toISOString(),
          kind: "worktree" as const,
          mainWorktreePath: payload.mainWorktreePath,
          managed: true,
          parentProjectId,
          repoRoot: payload.repoRoot,
        },
      };
      const nextChat = createChatConfig(nextProject);
      createdProjectId = nextProject.id;

      return {
        activeProjectId: nextProject.id,
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [nextProject.id]: nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: [],
        },
        chats: [...state.chats, nextChat],
        projects: [
          ...state.projects,
          {
            ...nextProject,
            ui: {
              ...nextProject.ui,
              activeChatId: nextChat.id,
              openChatIds: [nextChat.id],
              chatColumnWidths: {},
              rightPanelView: "changes",
            },
          },
        ],
      };
    });

    get().persist();
    return createdProjectId;
  },

  closeProject: (projectId: string) => {
    const browserTabs = get().browserTabsByProject[projectId] ?? [];
    const terminalSessionIds = get().projectTerminalSessionIds[projectId] ?? [];
    const desktopApi = getDesktopApi();
    for (const tab of browserTabs) {
      desktopApi?.updateBrowser({ destroyTab: tab.id });
    }
    for (const sessionId of terminalSessionIds) {
      void desktopApi?.stopTerminal(sessionId);
    }

    set((state) => {
      const closedProject = state.projects.find(
        (project) => project.id === projectId,
      );
      const nextProjects = state.projects.filter(
        (project) => project.id !== projectId,
      );
      const nextActiveProjectId = ensureActiveProject(
        nextProjects,
        state.activeProjectId === projectId ? null : state.activeProjectId,
      );
      const closedProjectPathKey = closedProject
        ? normalizeProjectPathKey(closedProject.path)
        : null;
      const nextClosedProjects = closedProject
        ? [
            ...state.closedProjects.filter(
              (project) =>
                project.id !== closedProject.id &&
                normalizeProjectPathKey(project.path) !== closedProjectPathKey,
            ),
            closedProject,
          ]
        : state.closedProjects;
      const nextProjectGitRefreshKeys = { ...state.projectGitRefreshKeys };
      const nextProjectFilesRefreshKeys = {
        ...state.projectFilesRefreshKeys,
      };
      const nextProjectFileOpenRequests = {
        ...state.projectFileOpenRequests,
      };
      const nextTerminalOrdinalByProject = {
        ...state.nextTerminalOrdinalByProject,
      };
      const nextTerminalOutput = { ...state.terminalOutput };
      const nextTerminalStatus = { ...state.terminalStatus };
      const nextTerminalTransport = { ...state.terminalTransport };
      const nextTerminalShell = { ...state.terminalShell };
      const nextTerminalSessionNames = { ...state.terminalSessionNames };
      const nextProjectTerminalSessionIds = {
        ...state.projectTerminalSessionIds,
      };
      const nextActiveTerminalSessionIdByProject = {
        ...state.activeTerminalSessionIdByProject,
      };
      const nextProjectTerminalPanelOpenByProject = {
        ...state.projectTerminalPanelOpenByProject,
      };
      const nextBrowserLoading = { ...state.browserLoading };
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };

      delete nextProjectGitRefreshKeys[projectId];
      delete nextProjectFilesRefreshKeys[projectId];
      delete nextProjectFileOpenRequests[projectId];
      delete nextTerminalOrdinalByProject[projectId];
      delete nextProjectTerminalSessionIds[projectId];
      delete nextActiveTerminalSessionIdByProject[projectId];
      delete nextProjectTerminalPanelOpenByProject[projectId];
      delete nextDraftChatIdByProject[projectId];
      for (const tab of browserTabs) {
        delete nextBrowserLoading[tab.id];
      }
      for (const sessionId of terminalSessionIds) {
        delete nextTerminalOutput[sessionId];
        delete nextTerminalStatus[sessionId];
        delete nextTerminalTransport[sessionId];
        delete nextTerminalShell[sessionId];
        delete nextTerminalSessionNames[sessionId];
      }
      const nextOpenProjects = nextProjects.map((project) => ({
        ...project,
        ui: sanitizeProjectUiForChats(
          state.chats,
          project.id,
          project.ui,
          ensureActiveChatForProject(
            state.chats,
            project.id,
            project.ui.activeChatId,
          ),
        ),
      }));
      const nextClosedProject = closedProject
        ? {
            ...closedProject,
            ui: sanitizeProjectUiForChats(
              state.chats,
              projectId,
              closedProject.ui,
              ensureActiveChatForProject(
                state.chats,
                projectId,
                closedProject.ui.activeChatId,
              ),
            ),
          }
        : null;
      const nextClosedProjectsWithUi = nextClosedProject
        ? [
            ...state.closedProjects.filter(
              (project) =>
                project.id !== nextClosedProject.id &&
                normalizeProjectPathKey(project.path) !== closedProjectPathKey,
            ),
            nextClosedProject,
          ]
        : nextClosedProjects;

      return {
        activeProjectId: nextActiveProjectId,
        closedProjects: nextClosedProjectsWithUi,
        nextTerminalOrdinalByProject,
        terminalOutput: nextTerminalOutput,
        terminalStatus: nextTerminalStatus,
        terminalTransport: nextTerminalTransport,
        terminalShell: nextTerminalShell,
        terminalSessionNames: nextTerminalSessionNames,
        projectTerminalSessionIds: nextProjectTerminalSessionIds,
        activeTerminalSessionIdByProject: nextActiveTerminalSessionIdByProject,
        projectTerminalPanelOpenByProject:
          nextProjectTerminalPanelOpenByProject,
        browserLoading: nextBrowserLoading,
        draftChatIdByProject: nextDraftChatIdByProject,
        projectGitRefreshKeys: nextProjectGitRefreshKeys,
        projectFilesRefreshKeys: nextProjectFilesRefreshKeys,
        projectFileOpenRequests: nextProjectFileOpenRequests,
        projects: nextOpenProjects,
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
