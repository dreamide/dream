import type { UIMessage } from "ai";
import { create } from "zustand";
import { getDesktopApi } from "@/lib/electron";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  getDefaultModelSelection,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import { dedupeModelOptions } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  BrowserTabState,
  ChatConfig,
  ChatSortOrder,
  PanelSizes,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
} from "@/types/ide";
import {
  ensureActiveChatForProject,
  ensureActiveProject,
  getChatsForProject,
  mergePersistedState,
  normalizeProjectPathKey,
} from "./ide-state";
import {
  type ClaudePermissionMode,
  type CodexPermissionMode,
  createProjectTerminalSessionId,
  dedupeModels,
  getBrowserTerminalSessionId,
  type ProviderModelState,
  type ProviderModelsResponse,
  type RightPanelView,
  type SettingsSection,
  STATE_STORAGE_KEY,
} from "./ide-types";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface IdeState {
  // Persisted state
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  chats: ChatConfig[];
  activeChatIdByProject: Record<string, string | null>;
  chatSort: ChatSortOrder;
  panelVisibility: PanelVisibility;
  panelSizes: PanelSizes;
  projectChatHistoryPanelOpenByProject: Record<string, boolean>;
  projectPanelSizesByProject: Record<string, PanelSizes>;
  projectRightPanelOpenByProject: Record<string, boolean>;
  settings: AppSettings;
  messagesByChatId: Record<string, UIMessage[]>;

  // Runtime state
  streamingChatIds: Record<string, boolean>;
  draftChatIdByProject: Record<string, string | null>;
  terminalOutput: Record<string, string>;
  terminalStatus: Record<string, "running" | "stopped">;
  terminalTransport: Record<string, "pty" | "pipe">;
  terminalShell: Record<string, string>;
  terminalSessionNames: Record<string, string>;
  nextTerminalOrdinalByProject: Record<string, number>;
  projectTerminalSessionIds: Record<string, string[]>;
  activeTerminalSessionIdByProject: Record<string, string | null>;
  projectTerminalPanelOpenByProject: Record<string, boolean>;
  outputPanelOpen: boolean;
  claudePermissionMode: ClaudePermissionMode;
  codexPermissionMode: CodexPermissionMode;
  browserError: string | null;
  browserLoading: Record<string, boolean>;
  browserTabsByProject: Record<string, BrowserTabState[]>;
  activeBrowserTabIdByProject: Record<string, string | null>;
  projectGitRefreshKeys: Record<string, number>;
  rightPanelView: RightPanelView;
  stateHydrated: boolean;
  isMacOs: boolean;
  isElectron: boolean;
  appReady: boolean;

  // Settings dialog state
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  modelSearchQuery: string;
  providerModels: {
    openai: ProviderModelState;
    anthropic: ProviderModelState;
    fetchedAt: string | null;
  };

  // Derived (computed inline via getters, but activeProject is common enough)
  getActiveProject: () => ProjectConfig | null;
  getChatsForProject: (projectId: string) => ChatConfig[];
  getActiveChat: () => ChatConfig | null;
  getBrowserTabs: (projectId: string | null | undefined) => BrowserTabState[];
  getActiveBrowserTab: (projectId?: string | null) => BrowserTabState | null;

  // Actions – projects
  setProjects: (projects: ProjectConfig[]) => void;
  setActiveProjectId: (id: string | null) => void;
  addProject: (path: string) => void;
  closeProject: (projectId: string) => void;
  updateProject: (
    projectId: string,
    updater: (project: ProjectConfig) => ProjectConfig,
  ) => void;
  addChat: (projectId: string, title?: string) => void;
  setActiveChatId: (projectId: string, chatId: string | null) => void;
  updateChat: (
    chatId: string,
    updater: (chat: ChatConfig) => ChatConfig,
  ) => void;
  deleteChat: (chatId: string) => void;
  permanentlyDeleteChats: (chatIds: string[]) => void;
  restoreChats: (chatIds: string[]) => void;
  setMessagesForChat: (chatId: string, messages: UIMessage[]) => void;
  setChatSort: (sortOrder: ChatSortOrder) => void;

  // Actions – panels
  togglePanel: (panel: keyof PanelVisibility) => void;
  setPanelSizes: (
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
  setProjectPanelSizes: (
    projectId: string,
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
  setProjectChatHistoryPanelOpen: (projectId: string, open: boolean) => void;
  setProjectRightPanelOpen: (projectId: string, open: boolean) => void;
  setOutputPanelOpen: (open: boolean) => void;
  setClaudePermissionMode: (value: ClaudePermissionMode) => void;
  setCodexPermissionMode: (value: CodexPermissionMode) => void;
  setRightPanelView: (view: RightPanelView) => void;

  // Actions – settings
  setSettings: (
    updater: AppSettings | ((prev: AppSettings) => AppSettings),
  ) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setModelSearchQuery: (query: string) => void;

  // Actions – provider management
  toggleProviderModel: (provider: AiProvider, model: string) => void;
  refreshProviderModels: () => Promise<void>;
  setProviderModels: (
    updater:
      | IdeState["providerModels"]
      | ((prev: IdeState["providerModels"]) => IdeState["providerModels"]),
  ) => void;

  // Actions – runtime
  appendTerminalOutput: (projectId: string, chunk: string) => void;
  clearTerminalOutput: (projectId: string) => void;
  setTerminalStatus: (projectId: string, status: "running" | "stopped") => void;
  setTerminalTransport: (projectId: string, transport: "pty" | "pipe") => void;
  setTerminalShell: (projectId: string, shell: string) => void;
  setTerminalSessionName: (sessionId: string, name: string) => void;
  setChatStreaming: (chatId: string, streaming: boolean) => void;
  bumpProjectGitRefreshKey: (projectId: string) => void;
  setBrowserError: (error: string | null) => void;
  setBrowserLoading: (id: string, loading: boolean) => void;
  ensureBrowserTabs: (projectId: string, initialUrl?: string) => void;
  createBrowserTab: (projectId: string, initialUrl?: string) => string | null;
  updateBrowserTab: (
    projectId: string,
    tabId: string,
    updater: (tab: BrowserTabState) => BrowserTabState,
  ) => void;
  closeBrowserTab: (projectId: string, tabId: string) => string | null;
  reorderBrowserTabs: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  setActiveBrowserTab: (projectId: string, tabId: string | null) => void;
  setIsMacOs: (value: boolean) => void;
  setIsElectron: (value: boolean) => void;
  setAppReady: (value: boolean) => void;
  openExternalUrl: (url: string) => void;

  // Actions – runner
  startRunner: () => Promise<void>;
  stopRunner: () => Promise<void>;

  // Actions – terminal
  openProjectTerminal: (projectId: string) => Promise<void>;
  addProjectTerminal: (projectId: string) => Promise<void>;
  setActiveProjectTerminalId: (
    projectId: string,
    sessionId: string | null,
  ) => void;
  reorderProjectTerminals: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  closeProjectTerminal: (projectId: string, sessionId: string) => Promise<void>;

  // Actions – hydration & persistence
  hydrate: () => Promise<void>;
  persist: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_MODELS: IdeState["providerModels"] = {
  anthropic: {
    error: null,
    installed: false,
    loading: false,
    models: [],
    source: "unavailable",
    version: null,
  },
  fetchedAt: null,
  openai: {
    error: null,
    installed: false,
    loading: false,
    models: [],
    source: "unavailable",
    version: null,
  },
};

const areMessagesEqual = (
  left: UIMessage[] | undefined,
  right: UIMessage[],
): boolean => {
  if (left === right) {
    return true;
  }

  if (!left || left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    if (l.id !== r.id || l.role !== r.role) return false;
    if (l.parts.length !== r.parts.length) return false;
    if (l.parts !== r.parts) {
      // Check the last part for streaming changes (text growth, tool result)
      const lp = l.parts[l.parts.length - 1] as Record<string, unknown>;
      const rp = r.parts[r.parts.length - 1] as Record<string, unknown>;
      if (lp !== rp) {
        if (lp?.type !== rp?.type) return false;
        if (
          lp?.type === "text" &&
          (lp as { text: string }).text !== (rp as { text: string }).text
        )
          return false;
        if (
          lp?.type === "tool-invocation" &&
          lp?.toolInvocation !== rp?.toolInvocation
        )
          return false;
      }
    }
  }

  return true;
};

const isGrowingTextualPart = (
  left: UIMessage["parts"][number],
  right: UIMessage["parts"][number],
) => {
  if (
    (left.type !== "text" && left.type !== "reasoning") ||
    left.type !== right.type
  ) {
    return false;
  }

  const previousText = "text" in left ? left.text : "";
  const nextText = "text" in right ? right.text : "";

  return (
    typeof previousText === "string" &&
    typeof nextText === "string" &&
    nextText.startsWith(previousText)
  );
};

const shouldTouchChatUpdatedAt = (
  previousMessages: UIMessage[] | undefined,
  nextMessages: UIMessage[],
) => {
  if (!previousMessages || previousMessages.length !== nextMessages.length) {
    return true;
  }

  const lastMessageIndex = nextMessages.length - 1;

  for (
    let messageIndex = 0;
    messageIndex < nextMessages.length;
    messageIndex++
  ) {
    const previousMessage = previousMessages[messageIndex];
    const nextMessage = nextMessages[messageIndex];

    if (previousMessage === nextMessage) {
      continue;
    }

    if (
      previousMessage.id !== nextMessage.id ||
      previousMessage.role !== nextMessage.role ||
      previousMessage.parts.length !== nextMessage.parts.length
    ) {
      return true;
    }

    if (previousMessage.parts === nextMessage.parts) {
      continue;
    }

    const lastPartIndex = nextMessage.parts.length - 1;

    for (let partIndex = 0; partIndex < nextMessage.parts.length; partIndex++) {
      const previousPart = previousMessage.parts[partIndex];
      const nextPart = nextMessage.parts[partIndex];

      if (previousPart === nextPart) {
        continue;
      }

      if (
        messageIndex === lastMessageIndex &&
        partIndex === lastPartIndex &&
        isGrowingTextualPart(previousPart, nextPart)
      ) {
        continue;
      }

      return true;
    }
  }

  return false;
};

const BROWSER_TAB_ID_PREFIX = "browser-tab";

const createBrowserTabId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${BROWSER_TAB_ID_PREFIX}-${crypto.randomUUID()}`;
  }

  return `${BROWSER_TAB_ID_PREFIX}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

const getBrowserTabTitle = (url: string) => {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) {
    return "New Tab";
  }

  try {
    return new URL(trimmed).hostname || "New Tab";
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").split("/")[0] || "New Tab";
  }
};

const createBrowserTabState = (url = ""): BrowserTabState => ({
  canGoBack: false,
  canGoForward: false,
  id: createBrowserTabId(),
  title: getBrowserTabTitle(url),
  url,
});

const getBrowserTabsForProject = (
  browserTabsByProject: Record<string, BrowserTabState[]>,
  projectId: string | null | undefined,
) => {
  if (!projectId) {
    return [];
  }

  return browserTabsByProject[projectId] ?? [];
};

const resolveActiveBrowserTab = (
  tabs: BrowserTabState[],
  activeTabId: string | null | undefined,
) => {
  if (tabs.length === 0) {
    return null;
  }

  if (activeTabId) {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab) {
      return activeTab;
    }
  }

  return tabs[0] ?? null;
};

const getDefaultTerminalSessionName = (ordinal: number) =>
  `Terminal ${ordinal}`;

const getTerminalOrdinalFromName = (name: string) => {
  const match = /^Terminal (\d+)$/.exec(name.trim());
  if (!match) {
    return null;
  }

  const ordinal = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(ordinal) ? ordinal : null;
};

const moveItem = <T>(items: T[], fromIndex: number, toIndex: number) => {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return items;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
};

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  projects: [],
  closedProjects: [],
  activeProjectId: null,
  chats: [],
  activeChatIdByProject: {},
  chatSort: "recent",
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  panelSizes: DEFAULT_PANEL_SIZES,
  projectChatHistoryPanelOpenByProject: {},
  projectPanelSizesByProject: {},
  projectRightPanelOpenByProject: {},
  settings: DEFAULT_SETTINGS,
  messagesByChatId: {},

  // ── Runtime state ───────────────────────────────────────────────────
  streamingChatIds: {},
  draftChatIdByProject: {},
  terminalOutput: {},
  terminalStatus: {},
  terminalTransport: {},
  terminalShell: {},
  terminalSessionNames: {},
  nextTerminalOrdinalByProject: {},
  projectTerminalSessionIds: {},
  activeTerminalSessionIdByProject: {},
  projectTerminalPanelOpenByProject: {},
  outputPanelOpen: false,
  claudePermissionMode: "ask-permissions",
  codexPermissionMode: "default",
  browserError: null,
  browserLoading: {},
  browserTabsByProject: {},
  activeBrowserTabIdByProject: {},
  projectGitRefreshKeys: {},
  rightPanelView: "changes",
  stateHydrated: false,
  isMacOs: false,
  isElectron: false,
  appReady: false,

  // ── Settings dialog state ───────────────────────────────────────────
  settingsOpen: false,
  settingsSection: "appearance",
  modelSearchQuery: "",
  providerModels: DEFAULT_PROVIDER_MODELS,

  // ── Getters ─────────────────────────────────────────────────────────
  getActiveProject: () => {
    const { activeProjectId, projects } = get();
    return projects.find((project) => project.id === activeProjectId) ?? null;
  },

  getChatsForProject: (projectId) => {
    const { chats } = get();
    return getChatsForProject(chats, projectId);
  },

  getActiveChat: () => {
    const { activeChatIdByProject, getActiveProject, chats } = get();
    const project = getActiveProject();
    if (!project) {
      return null;
    }

    const activeChatId = activeChatIdByProject[project.id] ?? null;
    return (
      chats.find(
        (chat) =>
          chat.projectId === project.id &&
          chat.id === activeChatId &&
          chat.deletedAt === null,
      ) ?? null
    );
  },

  getBrowserTabs: (projectId) => {
    const { browserTabsByProject } = get();
    return getBrowserTabsForProject(browserTabsByProject, projectId);
  },

  getActiveBrowserTab: (projectId) => {
    const state = get();
    const targetProjectId = projectId ?? state.getActiveProject()?.id ?? null;
    const tabs = getBrowserTabsForProject(
      state.browserTabsByProject,
      targetProjectId,
    );
    const activeTabId = targetProjectId
      ? state.activeBrowserTabIdByProject[targetProjectId]
      : null;
    return resolveActiveBrowserTab(tabs, activeTabId);
  },

  // ── Actions: projects ───────────────────────────────────────────────
  setProjects: (projects) => {
    set((state) => {
      const nextActiveProjectId = ensureActiveProject(
        projects,
        state.activeProjectId,
      );
      const nextActiveChatIdByProject = { ...state.activeChatIdByProject };
      let nextChats = state.chats;
      let nextMessagesByChatId = state.messagesByChatId;
      for (const project of projects) {
        let nextActiveChatId = ensureActiveChatForProject(
          nextChats,
          project.id,
          state.activeChatIdByProject[project.id] ?? null,
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

        nextActiveChatIdByProject[project.id] = nextActiveChatId;
      }

      return {
        activeProjectId: nextActiveProjectId,
        activeChatIdByProject: nextActiveChatIdByProject,
        chats: nextChats,
        messagesByChatId: nextMessagesByChatId,
        projects,
      };
    });
  },

  setActiveProjectId: (id) => {
    set((state) => {
      const nextActiveProjectId = ensureActiveProject(state.projects, id);

      if (nextActiveProjectId === state.activeProjectId) {
        return state;
      }

      return {
        activeProjectId: nextActiveProjectId,
      };
    });
  },

  addProject: (path) => {
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
          state.activeChatIdByProject[openProject.id] ?? null,
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
        const panelSizes =
          state.projectPanelSizesByProject[openProject.id] ??
          DEFAULT_PANEL_SIZES;
        const rightPanelOpen =
          state.projectRightPanelOpenByProject[openProject.id] ??
          DEFAULT_PANEL_VISIBILITY.right;
        const chatHistoryPanelOpen =
          state.projectChatHistoryPanelOpenByProject[openProject.id] ??
          DEFAULT_PANEL_VISIBILITY.left;

        return {
          activeProjectId: openProject.id,
          activeChatIdByProject: {
            ...state.activeChatIdByProject,
            [openProject.id]: nextActiveChatId,
          },
          chats: nextChats,
          messagesByChatId: nextMessagesByChatId,
          projectRightPanelOpenByProject: {
            ...state.projectRightPanelOpenByProject,
            [openProject.id]: rightPanelOpen,
          },
          projectChatHistoryPanelOpenByProject: {
            ...state.projectChatHistoryPanelOpenByProject,
            [openProject.id]: chatHistoryPanelOpen,
          },
          projectPanelSizesByProject: {
            ...state.projectPanelSizesByProject,
            [openProject.id]: panelSizes,
          },
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
          state.activeChatIdByProject[reopenedProject.id] ?? null,
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

        const panelSizes =
          state.projectPanelSizesByProject[reopenedProject.id] ??
          DEFAULT_PANEL_SIZES;
        const rightPanelOpen =
          state.projectRightPanelOpenByProject[reopenedProject.id] ??
          DEFAULT_PANEL_VISIBILITY.right;
        const chatHistoryPanelOpen =
          state.projectChatHistoryPanelOpenByProject[reopenedProject.id] ??
          DEFAULT_PANEL_VISIBILITY.left;

        return {
          activeProjectId: reopenedProject.id,
          activeChatIdByProject: {
            ...state.activeChatIdByProject,
            [reopenedProject.id]: nextActiveChatId,
          },
          closedProjects: state.closedProjects.filter(
            (project) =>
              normalizeProjectPathKey(project.path) !== pathKey &&
              project.id !== reopenedProject.id,
          ),
          messagesByChatId: nextMessagesByChatId,
          chats: nextChats,
          projectRightPanelOpenByProject: {
            ...state.projectRightPanelOpenByProject,
            [reopenedProject.id]: rightPanelOpen,
          },
          projectChatHistoryPanelOpenByProject: {
            ...state.projectChatHistoryPanelOpenByProject,
            [reopenedProject.id]: chatHistoryPanelOpen,
          },
          projectPanelSizesByProject: {
            ...state.projectPanelSizesByProject,
            [reopenedProject.id]: panelSizes,
          },
          projects: [...state.projects, reopenedProject],
        };
      }

      const nextProject = createProjectConfig(path, state.settings);
      const nextChat = createChatConfig(nextProject);

      return {
        activeProjectId: nextProject.id,
        activeChatIdByProject: {
          ...state.activeChatIdByProject,
          [nextProject.id]: nextChat.id,
        },
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [nextProject.id]: nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: [],
        },
        projectRightPanelOpenByProject: {
          ...state.projectRightPanelOpenByProject,
          [nextProject.id]: false,
        },
        projectChatHistoryPanelOpenByProject: {
          ...state.projectChatHistoryPanelOpenByProject,
          [nextProject.id]: true,
        },
        projectPanelSizesByProject: {
          ...state.projectPanelSizesByProject,
          [nextProject.id]: DEFAULT_PANEL_SIZES,
        },
        chats: [...state.chats, nextChat],
        projects: [...state.projects, nextProject],
      };
    });
  },

  closeProject: (projectId) => {
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
      const nextBrowserTabsByProject = { ...state.browserTabsByProject };
      const nextActiveBrowserTabIdByProject = {
        ...state.activeBrowserTabIdByProject,
      };
      const nextProjectGitRefreshKeys = { ...state.projectGitRefreshKeys };
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

      delete nextBrowserTabsByProject[projectId];
      delete nextActiveBrowserTabIdByProject[projectId];
      delete nextProjectGitRefreshKeys[projectId];
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
      const nextActiveChatIdByProject = { ...state.activeChatIdByProject };
      if (closedProject) {
        nextActiveChatIdByProject[projectId] = ensureActiveChatForProject(
          state.chats,
          projectId,
          state.activeChatIdByProject[projectId] ?? null,
        );
      }
      for (const project of nextProjects) {
        nextActiveChatIdByProject[project.id] = ensureActiveChatForProject(
          state.chats,
          project.id,
          state.activeChatIdByProject[project.id] ?? null,
        );
      }

      return {
        activeProjectId: nextActiveProjectId,
        activeChatIdByProject: nextActiveChatIdByProject,
        closedProjects: nextClosedProjects,
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
        browserTabsByProject: nextBrowserTabsByProject,
        activeBrowserTabIdByProject: nextActiveBrowserTabIdByProject,
        draftChatIdByProject: nextDraftChatIdByProject,
        projectGitRefreshKeys: nextProjectGitRefreshKeys,
        projects: nextProjects,
      };
    });
  },

  updateProject: (projectId, updater) => {
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? updater(project) : project,
      ),
    }));
  },

  addChat: (projectId, title) => {
    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }

      const existingDraftChatId = state.draftChatIdByProject[projectId] ?? null;
      if (
        existingDraftChatId &&
        state.chats.some((item) => item.id === existingDraftChatId)
      ) {
        return {
          activeProjectId: projectId,
          activeChatIdByProject: {
            ...state.activeChatIdByProject,
            [projectId]: existingDraftChatId,
          },
        };
      }

      const defaultSelection = getDefaultModelSelection(state.settings);
      const nextChat = createChatConfig(project, {
        model: defaultSelection.model || project.model,
        provider: defaultSelection.model
          ? defaultSelection.provider
          : project.provider,
        title,
      });

      return {
        activeProjectId: projectId,
        activeChatIdByProject: {
          ...state.activeChatIdByProject,
          [projectId]: nextChat.id,
        },
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [projectId]: nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: [],
        },
        chats: [...state.chats, nextChat],
      };
    });
  },

  setActiveChatId: (projectId, chatId) => {
    set((state) => {
      const nextActiveChatId =
        chatId &&
        state.chats.some(
          (chat) =>
            chat.projectId === projectId &&
            chat.id === chatId &&
            chat.deletedAt === null,
        )
          ? chatId
          : ensureActiveChatForProject(state.chats, projectId, chatId);

      return {
        activeChatIdByProject: {
          ...state.activeChatIdByProject,
          [projectId]: nextActiveChatId,
        },
      };
    });
  },

  updateChat: (chatId, updater) => {
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? updater(chat) : chat,
      ),
    }));
  },

  deleteChat: (chatId) => {
    set((state) => {
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat) {
        return state;
      }

      const deletedAt = new Date().toISOString();
      const nextChats = state.chats.map((item) =>
        item.id === chatId ? { ...item, deletedAt } : item,
      );
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };
      if (nextDraftChatIdByProject[chat.projectId] === chatId) {
        nextDraftChatIdByProject[chat.projectId] = null;
      }

      return {
        activeChatIdByProject: {
          ...state.activeChatIdByProject,
          [chat.projectId]: ensureActiveChatForProject(
            nextChats,
            chat.projectId,
            state.activeChatIdByProject[chat.projectId] === chatId
              ? null
              : (state.activeChatIdByProject[chat.projectId] ?? null),
          ),
        },
        draftChatIdByProject: nextDraftChatIdByProject,
        chats: nextChats,
      };
    });
    get().persist();
  },

  permanentlyDeleteChats: (chatIds) => {
    const idsToDelete = new Set(chatIds);
    if (idsToDelete.size === 0) {
      return;
    }

    set((state) => {
      const deletedChats = state.chats.filter((chat) =>
        idsToDelete.has(chat.id),
      );
      if (deletedChats.length === 0) {
        return state;
      }

      const affectedProjectIds = new Set(
        deletedChats.map((chat) => chat.projectId),
      );
      const nextChats = state.chats.filter((chat) => !idsToDelete.has(chat.id));
      const nextMessagesByChatId = { ...state.messagesByChatId };
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };

      for (const chat of deletedChats) {
        delete nextMessagesByChatId[chat.id];
        if (nextDraftChatIdByProject[chat.projectId] === chat.id) {
          nextDraftChatIdByProject[chat.projectId] = null;
        }
      }

      return {
        activeChatIdByProject: {
          ...state.activeChatIdByProject,
          ...Object.fromEntries(
            [...affectedProjectIds].map((projectId) => [
              projectId,
              ensureActiveChatForProject(
                nextChats,
                projectId,
                state.activeChatIdByProject[projectId] ?? null,
              ),
            ]),
          ),
        },
        draftChatIdByProject: nextDraftChatIdByProject,
        messagesByChatId: nextMessagesByChatId,
        chats: nextChats,
      };
    });
    get().persist();
  },

  restoreChats: (chatIds) => {
    const idsToRestore = new Set(chatIds);
    if (idsToRestore.size === 0) {
      return;
    }

    set((state) => ({
      chats: state.chats.map((chat) =>
        idsToRestore.has(chat.id) ? { ...chat, deletedAt: null } : chat,
      ),
    }));
    get().persist();
  },

  setMessagesForChat: (chatId, messages) => {
    set((state) => {
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat) {
        return state;
      }
      const messagesChanged = !areMessagesEqual(
        state.messagesByChatId[chatId],
        messages,
      );

      if (!messagesChanged) {
        return state;
      }

      const touchUpdatedAt = shouldTouchChatUpdatedAt(
        state.messagesByChatId[chatId],
        messages,
      );

      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };
      if (
        messages.length > 0 &&
        nextDraftChatIdByProject[chat.projectId] === chatId
      ) {
        nextDraftChatIdByProject[chat.projectId] = null;
      }

      return {
        draftChatIdByProject: nextDraftChatIdByProject,
        messagesByChatId: { ...state.messagesByChatId, [chatId]: messages },
        chats: touchUpdatedAt
          ? state.chats.map((item) =>
              item.id === chatId
                ? {
                    ...item,
                    updatedAt: new Date().toISOString(),
                  }
                : item,
            )
          : state.chats,
      };
    });
  },

  setChatSort: (chatSort) => set({ chatSort }),

  // ── Actions: panels ─────────────────────────────────────────────────
  togglePanel: (panel) => {
    if (panel === "middle") {
      return;
    }

    set((state) => {
      if (panel !== "right") {
        const nextOpen = !state.panelVisibility[panel];
        return {
          panelVisibility: {
            ...state.panelVisibility,
            [panel]: nextOpen,
            middle: true,
          },
          projectChatHistoryPanelOpenByProject:
            panel === "left" && state.activeProjectId
              ? {
                  ...state.projectChatHistoryPanelOpenByProject,
                  [state.activeProjectId]: nextOpen,
                }
              : state.projectChatHistoryPanelOpenByProject,
        };
      }

      const projectId = state.activeProjectId;
      const currentOpen = projectId
        ? (state.projectRightPanelOpenByProject[projectId] ??
          state.panelVisibility.right)
        : state.panelVisibility.right;
      const nextOpen = !currentOpen;

      return {
        panelVisibility: {
          ...state.panelVisibility,
          right: nextOpen,
          middle: true,
        },
        projectRightPanelOpenByProject: projectId
          ? {
              ...state.projectRightPanelOpenByProject,
              [projectId]: nextOpen,
            }
          : state.projectRightPanelOpenByProject,
      };
    });
  },
  setPanelSizes: (updater) => {
    set((state) => {
      const panelSizes =
        typeof updater === "function" ? updater(state.panelSizes) : updater;

      return {
        panelSizes,
        projectPanelSizesByProject: state.activeProjectId
          ? {
              ...state.projectPanelSizesByProject,
              [state.activeProjectId]: panelSizes,
            }
          : state.projectPanelSizesByProject,
      };
    });
  },
  setProjectPanelSizes: (projectId, updater) => {
    set((state) => {
      const previous =
        state.projectPanelSizesByProject[projectId] ?? DEFAULT_PANEL_SIZES;
      const panelSizes =
        typeof updater === "function" ? updater(previous) : updater;

      return {
        projectPanelSizesByProject: {
          ...state.projectPanelSizesByProject,
          [projectId]: panelSizes,
        },
      };
    });
  },
  setProjectChatHistoryPanelOpen: (projectId, open) => {
    set((state) => ({
      projectChatHistoryPanelOpenByProject: {
        ...state.projectChatHistoryPanelOpenByProject,
        [projectId]: open,
      },
    }));
  },
  setProjectRightPanelOpen: (projectId, open) => {
    set((state) => ({
      projectRightPanelOpenByProject: {
        ...state.projectRightPanelOpenByProject,
        [projectId]: open,
      },
    }));
  },
  setOutputPanelOpen: (open) => set({ outputPanelOpen: open }),
  setClaudePermissionMode: (value) => set({ claudePermissionMode: value }),
  setCodexPermissionMode: (value) => set({ codexPermissionMode: value }),
  setRightPanelView: (view) => set({ rightPanelView: view }),

  // ── Actions: settings ───────────────────────────────────────────────
  setSettings: (updater) => {
    set((state) => ({
      settings:
        typeof updater === "function" ? updater(state.settings) : updater,
    }));
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  setModelSearchQuery: (query) => set({ modelSearchQuery: query }),

  // ── Actions: provider management ────────────────────────────────────
  toggleProviderModel: (provider, model) => {
    set((state) => {
      const prev = state.settings;
      if (provider === "openai") {
        const current = dedupeModels(prev.openAiSelectedModels);
        const next = current.includes(model)
          ? current.filter((v) => v !== model)
          : [...current, model];
        const nextSettings = {
          ...prev,
          openAiSelectedModels: next,
        };
        return {
          settings: {
            ...nextSettings,
            defaultModel: getPreferredDefaultModel(nextSettings),
          },
        };
      }
      const current = dedupeModels(prev.anthropicSelectedModels);
      const next = current.includes(model)
        ? current.filter((v) => v !== model)
        : [...current, model];
      const nextSettings = {
        ...prev,
        anthropicSelectedModels: next,
      };
      return {
        settings: {
          ...nextSettings,
          defaultModel: getPreferredDefaultModel(nextSettings),
        },
      };
    });
  },

  refreshProviderModels: async () => {
    set((state) => ({
      providerModels: {
        ...state.providerModels,
        anthropic: {
          ...state.providerModels.anthropic,
          error: null,
          loading: true,
        },
        openai: { ...state.providerModels.openai, error: null, loading: true },
      },
    }));

    try {
      const response = await fetch("/api/provider-models", { method: "POST" });

      if (!response.ok)
        throw new Error(`Model fetch failed (${response.status}).`);

      const payload = (await response.json()) as ProviderModelsResponse;
      const nextOpenAiModels = dedupeModelOptions(payload.openai.models);
      const nextAnthropicModels = dedupeModelOptions(payload.anthropic.models);
      const nextOpenAiModelIds = nextOpenAiModels.map((model) => model.id);
      const nextAnthropicModelIds = nextAnthropicModels.map(
        (model) => model.id,
      );

      set({
        providerModels: {
          anthropic: {
            error: payload.anthropic.error ?? null,
            installed: payload.anthropic.installed,
            loading: false,
            models: nextAnthropicModels,
            source: payload.anthropic.source,
            version: payload.anthropic.version ?? null,
          },
          fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
          openai: {
            error: payload.openai.error ?? null,
            installed: payload.openai.installed,
            loading: false,
            models: nextOpenAiModels,
            source: payload.openai.source,
            version: payload.openai.version ?? null,
          },
        },
      });

      // Reconcile selected models
      set((state) => {
        const prev = state.settings;
        const currentOpenAiSelected = dedupeModels(
          prev.openAiSelectedModels,
        ).filter((m) => nextOpenAiModelIds.includes(m));
        const currentAnthropicSelected = dedupeModels(
          prev.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
        ).filter((m) => nextAnthropicModelIds.includes(m));

        const openAiSelectedModels =
          currentOpenAiSelected.length > 0 ? currentOpenAiSelected : [];
        const anthropicSelectedModels =
          currentAnthropicSelected.length > 0 ? currentAnthropicSelected : [];
        const nextSettings = {
          ...prev,
          anthropicSelectedModels,
          openAiSelectedModels,
        };
        const defaultModel = getPreferredDefaultModel(nextSettings);

        if (
          defaultModel === prev.defaultModel &&
          openAiSelectedModels.length === prev.openAiSelectedModels.length &&
          anthropicSelectedModels.length ===
            prev.anthropicSelectedModels.length &&
          openAiSelectedModels.every(
            (m, i) => prev.openAiSelectedModels[i] === m,
          ) &&
          anthropicSelectedModels.every(
            (m, i) => prev.anthropicSelectedModels[i] === m,
          )
        ) {
          return state;
        }

        return {
          settings: {
            ...nextSettings,
            defaultModel,
          },
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to fetch models.";
      set((state) => ({
        providerModels: {
          anthropic: {
            error: message,
            installed: state.providerModels.anthropic.installed,
            loading: false,
            models: state.providerModels.anthropic.models,
            source: state.providerModels.anthropic.source,
            version: state.providerModels.anthropic.version,
          },
          fetchedAt: state.providerModels.fetchedAt,
          openai: {
            error: message,
            installed: state.providerModels.openai.installed,
            loading: false,
            models: state.providerModels.openai.models,
            source: state.providerModels.openai.source,
            version: state.providerModels.openai.version,
          },
        },
      }));
    }
  },

  setProviderModels: (updater) => {
    set((state) => ({
      providerModels:
        typeof updater === "function" ? updater(state.providerModels) : updater,
    }));
  },

  // ── Actions: runtime ────────────────────────────────────────────────
  appendTerminalOutput: (projectId, chunk) => {
    set((state) => {
      const current = state.terminalOutput[projectId] ?? "";
      const next = `${current}${chunk}`;
      return {
        terminalOutput: {
          ...state.terminalOutput,
          [projectId]: next.slice(-150_000),
        },
      };
    });
  },

  clearTerminalOutput: (projectId) => {
    set((state) => ({
      terminalOutput: { ...state.terminalOutput, [projectId]: "" },
    }));
  },

  setTerminalStatus: (projectId, status) => {
    set((state) => ({
      terminalStatus: { ...state.terminalStatus, [projectId]: status },
    }));
  },

  setTerminalTransport: (projectId, transport) => {
    set((state) => ({
      terminalTransport: { ...state.terminalTransport, [projectId]: transport },
    }));
  },

  setTerminalShell: (projectId, shell) => {
    set((state) => ({
      terminalShell: { ...state.terminalShell, [projectId]: shell },
    }));
  },
  setTerminalSessionName: (sessionId, name) => {
    const normalizedSessionId =
      typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return;
    }

    const normalizedName = name.trim();
    set((state) => {
      const nextTerminalSessionNames = { ...state.terminalSessionNames };

      if (normalizedName) {
        nextTerminalSessionNames[normalizedSessionId] = normalizedName;
      } else {
        delete nextTerminalSessionNames[normalizedSessionId];
      }

      return {
        terminalSessionNames: nextTerminalSessionNames,
      };
    });
  },

  setChatStreaming: (chatId, streaming) =>
    set((state) => {
      const next = { ...state.streamingChatIds };
      if (streaming) {
        next[chatId] = true;
      } else {
        delete next[chatId];
      }
      return { streamingChatIds: next };
    }),
  bumpProjectGitRefreshKey: (projectId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => ({
      projectGitRefreshKeys: {
        ...state.projectGitRefreshKeys,
        [normalizedProjectId]:
          (state.projectGitRefreshKeys[normalizedProjectId] ?? 0) + 1,
      },
    }));
  },
  setBrowserError: (error) => set({ browserError: error }),
  setBrowserLoading: (id, loading) => {
    set((state) => ({
      browserLoading: { ...state.browserLoading, [id]: loading },
    }));
  },
  ensureBrowserTabs: (projectId, initialUrl = "") => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const existingTabs =
        state.browserTabsByProject[normalizedProjectId] ?? [];
      if (existingTabs.length > 0) {
        const activeTabId =
          state.activeBrowserTabIdByProject[normalizedProjectId] ?? null;
        if (activeTabId && existingTabs.some((tab) => tab.id === activeTabId)) {
          return state;
        }

        return {
          activeBrowserTabIdByProject: {
            ...state.activeBrowserTabIdByProject,
            [normalizedProjectId]: existingTabs[0]?.id ?? null,
          },
        };
      }

      const initialTab = createBrowserTabState(initialUrl);
      return {
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: [initialTab],
        },
        activeBrowserTabIdByProject: {
          ...state.activeBrowserTabIdByProject,
          [normalizedProjectId]: initialTab.id,
        },
      };
    });
  },
  createBrowserTab: (projectId, initialUrl = "") => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return null;
    }

    const nextTab = createBrowserTabState(initialUrl);
    set((state) => ({
      browserTabsByProject: {
        ...state.browserTabsByProject,
        [normalizedProjectId]: [
          ...(state.browserTabsByProject[normalizedProjectId] ?? []),
          nextTab,
        ],
      },
      activeBrowserTabIdByProject: {
        ...state.activeBrowserTabIdByProject,
        [normalizedProjectId]: nextTab.id,
      },
    }));

    return nextTab.id;
  },
  updateBrowserTab: (projectId, tabId, updater) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedProjectId || !normalizedTabId) {
      return;
    }

    set((state) => {
      const tabs = state.browserTabsByProject[normalizedProjectId] ?? [];
      let changed = false;
      const nextTabs = tabs.map((tab) => {
        if (tab.id !== normalizedTabId) {
          return tab;
        }

        const updatedTab = updater(tab);
        changed = changed || updatedTab !== tab;
        return updatedTab;
      });

      if (!changed) {
        return state;
      }

      return {
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: nextTabs,
        },
      };
    });
  },
  closeBrowserTab: (projectId, tabId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedProjectId || !normalizedTabId) {
      return null;
    }

    const existingTabs = get().browserTabsByProject[normalizedProjectId] ?? [];
    if (existingTabs.length <= 1) {
      return (
        resolveActiveBrowserTab(
          existingTabs,
          get().activeBrowserTabIdByProject[normalizedProjectId],
        )?.id ?? null
      );
    }

    const closingIndex = existingTabs.findIndex(
      (tab) => tab.id === normalizedTabId,
    );
    if (closingIndex === -1) {
      return (
        resolveActiveBrowserTab(
          existingTabs,
          get().activeBrowserTabIdByProject[normalizedProjectId],
        )?.id ?? null
      );
    }

    const remainingTabs = existingTabs.filter(
      (tab) => tab.id !== normalizedTabId,
    );
    const currentActiveTabId =
      get().activeBrowserTabIdByProject[normalizedProjectId] ?? null;
    const nextActiveTab =
      currentActiveTabId === normalizedTabId
        ? (remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ??
          null)
        : resolveActiveBrowserTab(remainingTabs, currentActiveTabId);
    const nextActiveTabId = nextActiveTab?.id ?? null;

    set((state) => {
      const nextBrowserLoading = { ...state.browserLoading };
      delete nextBrowserLoading[normalizedTabId];

      return {
        browserLoading: nextBrowserLoading,
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: remainingTabs,
        },
        activeBrowserTabIdByProject: {
          ...state.activeBrowserTabIdByProject,
          [normalizedProjectId]: nextActiveTabId,
        },
      };
    });

    return nextActiveTabId;
  },
  reorderBrowserTabs: (projectId, fromIndex, toIndex) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const tabs = state.browserTabsByProject[normalizedProjectId] ?? [];
      const nextTabs = moveItem(tabs, fromIndex, toIndex);
      if (nextTabs === tabs) {
        return state;
      }

      return {
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: nextTabs,
        },
      };
    });
  },
  setActiveBrowserTab: (projectId, tabId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const tabs = state.browserTabsByProject[normalizedProjectId] ?? [];
      const nextActiveTabId =
        tabId && tabs.some((tab) => tab.id === tabId)
          ? tabId
          : (tabs[0]?.id ?? null);

      return {
        activeBrowserTabIdByProject: {
          ...state.activeBrowserTabIdByProject,
          [normalizedProjectId]: nextActiveTabId,
        },
      };
    });
  },
  setIsMacOs: (value) => set({ isMacOs: value }),
  setIsElectron: (value) => set({ isElectron: value }),
  setAppReady: (value) => set({ appReady: value }),

  openExternalUrl: (url) => {
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },

  // ── Actions: runner ─────────────────────────────────────────────────
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

  // ── Actions: terminal ───────────────────────────────────────────────
  openProjectTerminal: async (projectId) => {
    const existingSessionIds = get().projectTerminalSessionIds[projectId] ?? [];

    if (existingSessionIds.length > 0) {
      const panelOpen =
        get().projectTerminalPanelOpenByProject[projectId] ?? false;
      const activeSessionId =
        get().activeTerminalSessionIdByProject[projectId] ??
        existingSessionIds[existingSessionIds.length - 1] ??
        null;

      if (!panelOpen) {
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

      set((state) => ({
        projectTerminalPanelOpenByProject: {
          ...state.projectTerminalPanelOpenByProject,
          [projectId]: false,
        },
      }));
      return;
    }

    await get().addProjectTerminal(projectId);
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
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      await desktopApi.stopTerminal(sessionId);
    }

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
      if (nextSessionIds.length === 0) {
        nextProjectTerminalPanelOpenByProject[projectId] = false;
      }

      return {
        terminalOutput: nextTerminalOutput,
        terminalStatus: nextTerminalStatus,
        terminalTransport: nextTerminalTransport,
        terminalShell: nextTerminalShell,
        terminalSessionNames: nextTerminalSessionNames,
        projectTerminalSessionIds: {
          ...state.projectTerminalSessionIds,
          [projectId]: nextSessionIds,
        },
        projectTerminalPanelOpenByProject:
          nextProjectTerminalPanelOpenByProject,
        activeTerminalSessionIdByProject: {
          ...state.activeTerminalSessionIdByProject,
          [projectId]: nextActiveSessionId,
        },
      };
    });
  },

  // ── Actions: hydration & persistence ────────────────────────────────
  hydrate: async () => {
    const desktopApi = getDesktopApi();
    let loaded: PersistedIdeState;

    if (desktopApi) {
      const rawState = await desktopApi.loadState();
      loaded = mergePersistedState(rawState);
    } else {
      const rawState = localStorage.getItem(STATE_STORAGE_KEY);
      if (!rawState) {
        loaded = {
          activeProjectId: null,
          activeChatIdByProject: {},
          chats: [],
          closedProjects: [],
          messagesByChatId: {},
          panelSizes: DEFAULT_PANEL_SIZES,
          panelVisibility: DEFAULT_PANEL_VISIBILITY,
          projectChatHistoryPanelOpenByProject: {},
          projectPanelSizesByProject: {},
          projectRightPanelOpenByProject: {},
          projects: [],
          settings: DEFAULT_SETTINGS,
          chatSort: "recent",
        };
      } else {
        try {
          loaded = mergePersistedState(
            JSON.parse(rawState) as PersistedIdeState,
          );
        } catch {
          loaded = {
            activeProjectId: null,
            activeChatIdByProject: {},
            chats: [],
            closedProjects: [],
            messagesByChatId: {},
            panelSizes: DEFAULT_PANEL_SIZES,
            panelVisibility: DEFAULT_PANEL_VISIBILITY,
            projectChatHistoryPanelOpenByProject: {},
            projectPanelSizesByProject: {},
            projectRightPanelOpenByProject: {},
            projects: [],
            settings: DEFAULT_SETTINGS,
            chatSort: "recent",
          };
        }
      }
    }

    const nextActiveProjectId = ensureActiveProject(
      loaded.projects,
      loaded.activeProjectId,
    );

    const nextPanelSizes = nextActiveProjectId
      ? (loaded.projectPanelSizesByProject[nextActiveProjectId] ??
        loaded.panelSizes)
      : loaded.panelSizes;
    const nextChatHistoryPanelOpen = nextActiveProjectId
      ? (loaded.projectChatHistoryPanelOpenByProject[nextActiveProjectId] ??
        loaded.panelVisibility.left)
      : loaded.panelVisibility.left;

    set({
      projects: loaded.projects,
      closedProjects: loaded.closedProjects,
      activeProjectId: nextActiveProjectId,
      chats: loaded.chats,
      activeChatIdByProject: Object.fromEntries(
        [...loaded.projects, ...loaded.closedProjects].map((project) => [
          project.id,
          ensureActiveChatForProject(
            loaded.chats,
            project.id,
            loaded.activeChatIdByProject[project.id] ?? null,
          ),
        ]),
      ),
      messagesByChatId: loaded.messagesByChatId,
      panelSizes: nextPanelSizes,
      panelVisibility: {
        ...loaded.panelVisibility,
        left: nextChatHistoryPanelOpen,
        middle: true,
      },
      projectChatHistoryPanelOpenByProject:
        loaded.projectChatHistoryPanelOpenByProject,
      projectPanelSizesByProject: loaded.projectPanelSizesByProject,
      projectRightPanelOpenByProject: loaded.projectRightPanelOpenByProject,
      draftChatIdByProject: {},
      settings: loaded.settings,
      chatSort: loaded.chatSort,
      stateHydrated: true,
    });
  },

  persist: () => {
    const {
      activeProjectId,
      activeChatIdByProject,
      chatSort,
      chats,
      closedProjects,
      draftChatIdByProject,
      messagesByChatId,
      panelSizes,
      panelVisibility,
      projectChatHistoryPanelOpenByProject,
      projectPanelSizesByProject,
      projectRightPanelOpenByProject,
      projects,
      settings,
      stateHydrated,
    } = get();
    if (!stateHydrated) return;

    const allProjects = [...projects, ...closedProjects];
    const knownProjectIds = new Set(allProjects.map((project) => project.id));
    const persistedChats = chats.filter((chat) => {
      if (!knownProjectIds.has(chat.projectId)) {
        return false;
      }

      if (draftChatIdByProject[chat.projectId] === chat.id) {
        return false;
      }

      return (
        chat.deletedAt !== null || (messagesByChatId[chat.id]?.length ?? 0) > 0
      );
    });
    const persistedMessagesByChatId = Object.fromEntries(
      persistedChats.map((chat) => [chat.id, messagesByChatId[chat.id] ?? []]),
    );

    const nextState: PersistedIdeState = {
      activeProjectId: ensureActiveProject(projects, activeProjectId),
      activeChatIdByProject: Object.fromEntries(
        allProjects.map((project) => [
          project.id,
          ensureActiveChatForProject(
            persistedChats,
            project.id,
            activeChatIdByProject[project.id] ?? null,
          ),
        ]),
      ),
      chats: persistedChats,
      chatSort,
      closedProjects,
      messagesByChatId: persistedMessagesByChatId,
      panelSizes,
      panelVisibility: {
        ...panelVisibility,
        middle: true,
      },
      projectPanelSizesByProject,
      projectChatHistoryPanelOpenByProject,
      projectRightPanelOpenByProject,
      projects,
      settings,
    };

    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.saveState(nextState);
    } else {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState));
    }
  },
}));
