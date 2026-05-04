import { getDesktopApi } from "@/lib/electron";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { PersistedIdeState, ProjectConfig } from "@/types/ide";
import {
  ensureActiveChatForProject,
  ensureActiveProject,
  mergePersistedState,
} from "../ide-state";
import { STATE_STORAGE_KEY } from "../ide-types";
import type { IdeState } from "./ide-store-types";

const createEmptyPersistedState = (): PersistedIdeState => ({
  activeProjectId: null,
  activeBrowserTabIdByProject: {},
  browserTabsByProject: {},
  chats: [],
  chatSort: "recent",
  closedProjects: [],
  messagesByChatId: {},
  projects: [],
  settings: DEFAULT_SETTINGS,
});

export const loadPersistedIdeState = async (): Promise<PersistedIdeState> => {
  const desktopApi = getDesktopApi();

  if (desktopApi) {
    const rawState = await desktopApi.loadState();
    return mergePersistedState(rawState);
  }

  const rawState = localStorage.getItem(STATE_STORAGE_KEY);
  if (!rawState) {
    return createEmptyPersistedState();
  }

  try {
    return mergePersistedState(JSON.parse(rawState) as PersistedIdeState);
  } catch {
    return createEmptyPersistedState();
  }
};

export const createPersistedIdeState = ({
  activeBrowserTabIdByProject,
  activeProjectId,
  browserTabsByProject,
  chats,
  chatSort,
  closedProjects,
  draftChatIdByProject,
  messagesByChatId,
  projects,
  settings,
}: Pick<
  IdeState,
  | "activeBrowserTabIdByProject"
  | "activeProjectId"
  | "browserTabsByProject"
  | "chats"
  | "chatSort"
  | "closedProjects"
  | "draftChatIdByProject"
  | "messagesByChatId"
  | "projects"
  | "settings"
>): PersistedIdeState => {
  const allProjects = [...projects, ...closedProjects];
  const knownProjectIds = new Set(allProjects.map((project) => project.id));
  const persistedChats = chats.filter((chat) => {
    if (!knownProjectIds.has(chat.projectId)) {
      return false;
    }

    const messageCount = messagesByChatId[chat.id]?.length ?? 0;
    if (
      draftChatIdByProject[chat.projectId] === chat.id &&
      messageCount === 0
    ) {
      return false;
    }

    return chat.deletedAt !== null || messageCount > 0;
  });
  const persistedMessagesByChatId = Object.fromEntries(
    persistedChats.map((chat) => [chat.id, messagesByChatId[chat.id] ?? []]),
  );
  const sanitizeProjectForPersistence = (project: ProjectConfig) => ({
    ...project,
    ui: {
      ...project.ui,
      activeChatId: ensureActiveChatForProject(
        persistedChats,
        project.id,
        project.ui.activeChatId,
      ),
    },
  });
  const persistedProjects = projects.map(sanitizeProjectForPersistence);
  const persistedClosedProjects = closedProjects.map(
    sanitizeProjectForPersistence,
  );
  const persistedBrowserTabsByProject = Object.fromEntries(
    Object.entries(browserTabsByProject).filter(
      ([projectId, tabs]) => knownProjectIds.has(projectId) && tabs.length > 0,
    ),
  );
  const persistedActiveBrowserTabIdByProject = Object.fromEntries(
    Object.entries(persistedBrowserTabsByProject).map(([projectId, tabs]) => {
      const activeTabId = activeBrowserTabIdByProject[projectId] ?? null;
      return [
        projectId,
        activeTabId && tabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (tabs[0]?.id ?? null),
      ];
    }),
  );

  return {
    activeProjectId: ensureActiveProject(projects, activeProjectId),
    activeBrowserTabIdByProject: persistedActiveBrowserTabIdByProject,
    browserTabsByProject: persistedBrowserTabsByProject,
    chats: persistedChats,
    chatSort,
    closedProjects: persistedClosedProjects,
    messagesByChatId: persistedMessagesByChatId,
    projects: persistedProjects,
    settings,
  };
};

export const savePersistedIdeState = (state: PersistedIdeState) => {
  const desktopApi = getDesktopApi();
  if (desktopApi) {
    void desktopApi.saveState(state);
    return;
  }

  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
};
