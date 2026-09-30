import { getDesktopApi } from "@/lib/electron";
import {
  createChatConfig,
  createProjectConfig,
  getDefaultModelSelection,
} from "@/lib/ide-defaults";
import type { ProjectConfig, ProjectWorktreeInfo } from "@/types/ide";
import {
  ensureActiveChatForProject,
  ensureActiveProject,
  normalizeProjectPathKey,
  sanitizeProjectUiForChats,
} from "../ide-state";
import { deleteTerminalScrollback } from "../terminal-scrollback";
import { updateProjectInList, updateProjectUiInList } from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { dropProjectRuntimeState } from "./project-runtime-state";

const touchProjectInList = (
  projects: ProjectConfig[],
  projectId: string,
  lastUsedAt: string,
) =>
  updateProjectInList(projects, projectId, (project) => ({
    ...project,
    lastUsedAt,
  }));

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
> => {
  return {
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
              permissionMode: state.settings.defaultPermissionMode,
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
        const lastUsedAt = new Date().toISOString();
        const nextCompletedChatIds = { ...state.completedChatIds };
        if (nextActiveProjectId) {
          for (const chat of state.chats) {
            if (chat.projectId === nextActiveProjectId) {
              delete nextCompletedChatIds[chat.id];
            }
          }
        }
        const completedChatIdsChanged =
          Object.keys(nextCompletedChatIds).length !==
          Object.keys(state.completedChatIds).length;

        if (
          nextActiveProjectId === state.activeProjectId &&
          !completedChatIdsChanged
        ) {
          return state;
        }

        return {
          activeProjectId: nextActiveProjectId,
          completedChatIds: nextCompletedChatIds,
          projects: nextActiveProjectId
            ? touchProjectInList(
                state.projects,
                nextActiveProjectId,
                lastUsedAt,
              )
            : state.projects,
        };
      });
    },

    addProject: (
      path: string,
      addOptions?: { activate?: boolean; worktree?: ProjectWorktreeInfo },
    ) => {
      // `activate: false` opens the project without switching to it.
      const activate = addOptions?.activate !== false;
      const worktree = addOptions?.worktree ?? null;
      const withWorktree = <T extends ProjectConfig>(project: T): T =>
        worktree && !project.worktree ? { ...project, worktree } : project;
      set((state) => {
        const pathKey = normalizeProjectPathKey(path);
        const lastUsedAt = new Date().toISOString();
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
              permissionMode: state.settings.defaultPermissionMode,
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
            ...(activate ? { activeProjectId: openProject.id } : {}),
            chats: nextChats,
            messagesByChatId: nextMessagesByChatId,
            projects: updateProjectUiInList(
              touchProjectInList(
                openProject.worktree || !worktree
                  ? state.projects
                  : updateProjectInList(
                      state.projects,
                      openProject.id,
                      withWorktree,
                    ),
                openProject.id,
                lastUsedAt,
              ),
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
          const reopenedProject = withWorktree({
            ...closedProject,
            lastUsedAt,
            path,
          });
          let nextChats = state.chats;
          let nextMessagesByChatId = state.messagesByChatId;
          let nextActiveChatId = ensureActiveChatForProject(
            nextChats,
            reopenedProject.id,
            reopenedProject.ui.activeChatId,
          );

          if (!nextActiveChatId) {
            const nextChat = createChatConfig(reopenedProject, {
              permissionMode: state.settings.defaultPermissionMode,
            });
            nextChats = [...nextChats, nextChat];
            nextMessagesByChatId = {
              ...nextMessagesByChatId,
              [nextChat.id]: [],
            };
            nextActiveChatId = nextChat.id;
          }

          return {
            ...(activate ? { activeProjectId: reopenedProject.id } : {}),
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

        const nextProject = withWorktree(
          createProjectConfig(path, state.settings),
        );
        const nextChat = createChatConfig(nextProject, {
          permissionMode: state.settings.defaultPermissionMode,
        });

        return {
          ...(activate ? { activeProjectId: nextProject.id } : {}),
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

    stopProjectTerminals: (projectId: string) => {
      const terminalSessionIds =
        get().projectTerminalSessionIds?.[projectId] ?? [];
      const desktopApi = getDesktopApi();
      for (const sessionId of terminalSessionIds) {
        void desktopApi?.stopTerminal(sessionId);
        deleteTerminalScrollback(sessionId);
      }
    },

    closeProject: (projectId: string) => {
      get().stopProjectTerminals(projectId);

      set((state) => {
        const closedProject = state.projects.find(
          (project) => project.id === projectId,
        );
        const closedAt = new Date().toISOString();
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
        const withValidChat = (project: ProjectConfig): ProjectConfig => ({
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
        });
        const nextClosedProjects = closedProject
          ? [
              ...state.closedProjects.filter(
                (project) =>
                  project.id !== closedProject.id &&
                  normalizeProjectPathKey(project.path) !==
                    closedProjectPathKey,
              ),
              withValidChat({ ...closedProject, lastUsedAt: closedAt }),
            ]
          : state.closedProjects;

        return {
          ...dropProjectRuntimeState(state, projectId),
          activeProjectId: nextActiveProjectId,
          closedProjects: nextClosedProjects,
          projects: nextProjects.map(withValidChat),
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
  };
};
