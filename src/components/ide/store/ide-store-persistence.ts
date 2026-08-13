import type { UIMessage } from "ai";
import { getDesktopApi } from "@/lib/electron";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { PersistedIdeState, ProjectConfig } from "@/types/ide";
import {
  ensureActiveProject,
  mergePersistedState,
  sanitizeProjectUiForChats,
} from "../ide-state";
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

const STATE_LOAD_TIMEOUT_MS = 8000;

const requireDesktopApi = () => {
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    throw new Error("Dream desktop API is unavailable.");
  }

  return desktopApi;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
};

export const loadPersistedIdeState = async (): Promise<PersistedIdeState> => {
  const desktopApi = requireDesktopApi();

  try {
    const rawState = await withTimeout(
      desktopApi.loadState(),
      STATE_LOAD_TIMEOUT_MS,
      "Timed out loading persisted Dream state.",
    );
    return mergePersistedState(rawState);
  } catch (error) {
    console.warn("Unable to load persisted Dream state.", error);
    return createEmptyPersistedState();
  }
};

export const loadPersistedChatMessages = async (
  chatId: string,
): Promise<UIMessage[]> => {
  const desktopApi = requireDesktopApi();

  try {
    return await withTimeout(
      desktopApi.loadChatMessages(chatId),
      STATE_LOAD_TIMEOUT_MS,
      `Timed out loading messages for chat ${chatId}.`,
    );
  } catch (error) {
    console.warn(`Unable to load messages for chat ${chatId}.`, error);
    throw error;
  }
};

export const createPersistedIdeState = ({
  activeBrowserTabIdByProject,
  activeProjectId,
  browserTabsByProject,
  chats,
  chatSort,
  closedProjects,
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
  | "messagesByChatId"
  | "projects"
  | "settings"
>): PersistedIdeState => {
  const allProjects = [...projects, ...closedProjects];
  const knownProjectIds = new Set(allProjects.map((project) => project.id));
  const activeChatIdByProject = new Map(
    allProjects.map((project) => [project.id, project.ui.activeChatId]),
  );
  const persistedChats = chats.filter((chat) => {
    if (!knownProjectIds.has(chat.projectId)) {
      return false;
    }

    if (chat.deletedAt !== null) {
      return true;
    }

    const messageCount =
      messagesByChatId[chat.id]?.length ?? chat.messageCount ?? 0;
    if (messageCount > 0) {
      return true;
    }

    // Keep an empty chat only while it is the chat currently open for its
    // project so a freshly created chat survives an app restart. Any other
    // empty draft chats are dropped from persistence.
    return activeChatIdByProject.get(chat.projectId) === chat.id;
  });
  // A missing key means the transcript has not been loaded in this renderer.
  // Preserve that distinction so metadata-only saves never erase lazy rows.
  const persistedMessagesByChatId = Object.fromEntries(
    persistedChats.flatMap((chat) =>
      Object.hasOwn(messagesByChatId, chat.id)
        ? [[chat.id, messagesByChatId[chat.id]]]
        : [],
    ),
  );
  const sanitizeProjectForPersistence = (project: ProjectConfig) => ({
    ...project,
    ui: sanitizeProjectUiForChats(persistedChats, project.id, project.ui),
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
  void requireDesktopApi().saveState(state);
};

export const savePersistedChatMessages = async (
  chatId: string,
  messages: UIMessage[],
) => {
  await requireDesktopApi().saveChatMessages({ chatId, messages });
};

export const savePersistedActiveProject = (
  activeProjectId: string | null,
  lastUsedAt: string | null,
) => {
  const desktopApi = requireDesktopApi();
  if (typeof desktopApi.saveActiveProject !== "function") {
    return;
  }

  void desktopApi
    .saveActiveProject({
      activeProjectId,
      lastUsedAt,
    })
    .catch((error: unknown) => {
      console.warn("Unable to persist the active Dream project.", error);
    });
};
