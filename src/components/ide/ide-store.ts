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
  ChatConfig,
  ChatSortOrder,
  PanelSizes,
  PanelVisibility,
  PersistedIdeState,
  PreviewTabState,
  ProjectConfig,
} from "@/types/ide";
import {
  ensureActiveProject,
  ensureActiveChatForProject,
  getChatsForProject,
  mergePersistedState,
} from "./ide-state";
import {
  type ClaudePermissionMode,
  type CodexPermissionMode,
  createProjectTerminalSessionId,
  dedupeModels,
  getPreviewTerminalSessionId,
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
  activeProjectId: string | null;
  chats: ChatConfig[];
  activeChatIdByProject: Record<string, string | null>;
  chatSort: ChatSortOrder;
  panelVisibility: PanelVisibility;
  panelSizes: PanelSizes;
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
  projectTerminalPanelOpen: boolean;
  outputPanelOpen: boolean;
  claudePermissionMode: ClaudePermissionMode;
  codexPermissionMode: CodexPermissionMode;
  previewError: string | null;
  previewLoading: Record<string, boolean>;
  previewTabsByProject: Record<string, PreviewTabState[]>;
  activePreviewTabIdByProject: Record<string, string | null>;
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
  getPreviewTabs: (projectId: string | null | undefined) => PreviewTabState[];
  getActivePreviewTab: (projectId?: string | null) => PreviewTabState | null;

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
  archiveChat: (chatId: string) => void;
  setMessagesForChat: (chatId: string, messages: UIMessage[]) => void;
  setChatSort: (sortOrder: ChatSortOrder) => void;

  // Actions – panels
  togglePanel: (panel: keyof PanelVisibility) => void;
  setPanelSizes: (
    updater: PanelSizes | ((prev: PanelSizes) => PanelSizes),
  ) => void;
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
  setPreviewError: (error: string | null) => void;
  setPreviewLoading: (id: string, loading: boolean) => void;
  ensurePreviewTabs: (projectId: string, initialUrl?: string) => void;
  createPreviewTab: (projectId: string, initialUrl?: string) => string | null;
  updatePreviewTab: (
    projectId: string,
    tabId: string,
    updater: (tab: PreviewTabState) => PreviewTabState,
  ) => void;
  closePreviewTab: (projectId: string, tabId: string) => string | null;
  setActivePreviewTab: (projectId: string, tabId: string | null) => void;
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
  },
  fetchedAt: null,
  openai: {
    error: null,
    installed: false,
    loading: false,
    models: [],
    source: "unavailable",
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

const PREVIEW_TAB_ID_PREFIX = "preview-tab";

const createPreviewTabId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${PREVIEW_TAB_ID_PREFIX}-${crypto.randomUUID()}`;
  }

  return `${PREVIEW_TAB_ID_PREFIX}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

const getPreviewTabTitle = (url: string) => {
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

const createPreviewTabState = (url = ""): PreviewTabState => ({
  canGoBack: false,
  canGoForward: false,
  id: createPreviewTabId(),
  title: getPreviewTabTitle(url),
  url,
});

const getPreviewTabsForProject = (
  previewTabsByProject: Record<string, PreviewTabState[]>,
  projectId: string | null | undefined,
) => {
  if (!projectId) {
    return [];
  }

  return previewTabsByProject[projectId] ?? [];
};

const resolveActivePreviewTab = (
  tabs: PreviewTabState[],
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

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  projects: [],
  activeProjectId: null,
  chats: [],
  activeChatIdByProject: {},
  chatSort: "recent",
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  panelSizes: DEFAULT_PANEL_SIZES,
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
  projectTerminalPanelOpen: false,
  outputPanelOpen: false,
  claudePermissionMode: "ask-permissions",
  codexPermissionMode: "default",
  previewError: null,
  previewLoading: {},
  previewTabsByProject: {},
  activePreviewTabIdByProject: {},
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
      getChatsForProject(chats, project.id).find(
        (chat) => chat.id === activeChatId,
      ) ?? null
    );
  },

  getPreviewTabs: (projectId) => {
    const { previewTabsByProject } = get();
    return getPreviewTabsForProject(previewTabsByProject, projectId);
  },

  getActivePreviewTab: (projectId) => {
    const state = get();
    const targetProjectId = projectId ?? state.getActiveProject()?.id ?? null;
    const tabs = getPreviewTabsForProject(
      state.previewTabsByProject,
      targetProjectId,
    );
    const activeTabId = targetProjectId
      ? state.activePreviewTabIdByProject[targetProjectId]
      : null;
    return resolveActivePreviewTab(tabs, activeTabId);
  },

  // ── Actions: projects ───────────────────────────────────────────────
  setProjects: (projects) => {
    set((state) => {
      const nextActiveProjectId = ensureActiveProject(
        projects,
        state.activeProjectId,
      );
      const nextActiveChatIdByProject = Object.fromEntries(
        projects.map((project) => [
          project.id,
          ensureActiveChatForProject(
            state.chats,
            project.id,
            state.activeChatIdByProject[project.id] ?? null,
          ),
        ]),
      );

      return {
        activeProjectId: nextActiveProjectId,
        activeChatIdByProject: nextActiveChatIdByProject,
        projects,
      };
    });
  },

  setActiveProjectId: (id) => {
    set((state) => ({
      activeProjectId: ensureActiveProject(state.projects, id),
    }));
  },

  addProject: (path) => {
    set((state) => {
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
        chats: [...state.chats, nextChat],
        projects: [...state.projects, nextProject],
      };
    });
  },

  closeProject: (projectId) => {
    const previewTabs = get().previewTabsByProject[projectId] ?? [];
    const desktopApi = getDesktopApi();
    for (const tab of previewTabs) {
      desktopApi?.updatePreview({ destroyTab: tab.id });
    }

    set((state) => {
      const nextProjects = state.projects.filter(
        (project) => project.id !== projectId,
      );
      const nextChats = state.chats.filter(
        (chat) => chat.projectId !== projectId,
      );
      const nextMessagesByChatId = Object.fromEntries(
        Object.entries(state.messagesByChatId).filter(([chatId]) =>
          nextChats.some((chat) => chat.id === chatId),
        ),
      );
      const nextActiveProjectId = ensureActiveProject(
        nextProjects,
        state.activeProjectId === projectId ? null : state.activeProjectId,
      );
      const nextPreviewTabsByProject = { ...state.previewTabsByProject };
      const nextActivePreviewTabIdByProject = {
        ...state.activePreviewTabIdByProject,
      };
      const nextProjectGitRefreshKeys = { ...state.projectGitRefreshKeys };
      const nextTerminalOrdinalByProject = {
        ...state.nextTerminalOrdinalByProject,
      };
      const nextPreviewLoading = { ...state.previewLoading };
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };

      delete nextPreviewTabsByProject[projectId];
      delete nextActivePreviewTabIdByProject[projectId];
      delete nextProjectGitRefreshKeys[projectId];
      delete nextTerminalOrdinalByProject[projectId];
      delete nextDraftChatIdByProject[projectId];
      for (const tab of previewTabs) {
        delete nextPreviewLoading[tab.id];
      }

      return {
        activeProjectId: nextActiveProjectId,
        activeChatIdByProject: Object.fromEntries(
          nextProjects.map((project) => [
            project.id,
            ensureActiveChatForProject(
              nextChats,
              project.id,
              state.activeChatIdByProject[project.id] ?? null,
            ),
          ]),
        ),
        messagesByChatId: nextMessagesByChatId,
        nextTerminalOrdinalByProject,
        previewLoading: nextPreviewLoading,
        previewTabsByProject: nextPreviewTabsByProject,
        activePreviewTabIdByProject: nextActivePreviewTabIdByProject,
        draftChatIdByProject: nextDraftChatIdByProject,
        projectGitRefreshKeys: nextProjectGitRefreshKeys,
        projects: nextProjects,
        chats: nextChats,
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
    set((state) => ({
      activeChatIdByProject: {
        ...state.activeChatIdByProject,
        [projectId]: ensureActiveChatForProject(
          state.chats,
          projectId,
          chatId,
        ),
      },
    }));
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

      const nextChats = state.chats.filter((item) => item.id !== chatId);
      const nextMessagesByChatId = { ...state.messagesByChatId };
      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };
      delete nextMessagesByChatId[chatId];
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
        messagesByChatId: nextMessagesByChatId,
        chats: nextChats,
      };
    });
  },

  archiveChat: (chatId) => {
    set((state) => {
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat) {
        return state;
      }

      const archivedAt = new Date().toISOString();
      const nextChats = state.chats.map((item) =>
        item.id === chatId ? { ...item, archivedAt } : item,
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

      const nextDraftChatIdByProject = { ...state.draftChatIdByProject };
      if (messages.length > 0 && nextDraftChatIdByProject[chat.projectId] === chatId) {
        nextDraftChatIdByProject[chat.projectId] = null;
      }

      return {
        draftChatIdByProject: nextDraftChatIdByProject,
        messagesByChatId: { ...state.messagesByChatId, [chatId]: messages },
        chats: state.chats.map((item) =>
          item.id === chatId
            ? {
                ...item,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      };
    });
  },

  setChatSort: (chatSort) => set({ chatSort }),

  // ── Actions: panels ─────────────────────────────────────────────────
  togglePanel: (panel) => {
    if (panel === "middle") {
      return;
    }

    set((state) => ({
      panelVisibility: {
        ...state.panelVisibility,
        [panel]: !state.panelVisibility[panel],
        middle: true,
      },
    }));
  },
  setPanelSizes: (updater) => {
    set((state) => ({
      panelSizes:
        typeof updater === "function" ? updater(state.panelSizes) : updater,
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
          },
          fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
          openai: {
            error: payload.openai.error ?? null,
            installed: payload.openai.installed,
            loading: false,
            models: nextOpenAiModels,
            source: payload.openai.source,
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
          },
          fetchedAt: state.providerModels.fetchedAt,
          openai: {
            error: message,
            installed: state.providerModels.openai.installed,
            loading: false,
            models: state.providerModels.openai.models,
            source: state.providerModels.openai.source,
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
  setPreviewError: (error) => set({ previewError: error }),
  setPreviewLoading: (id, loading) => {
    set((state) => ({
      previewLoading: { ...state.previewLoading, [id]: loading },
    }));
  },
  ensurePreviewTabs: (projectId, initialUrl = "") => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const existingTabs =
        state.previewTabsByProject[normalizedProjectId] ?? [];
      if (existingTabs.length > 0) {
        const activeTabId =
          state.activePreviewTabIdByProject[normalizedProjectId] ?? null;
        if (activeTabId && existingTabs.some((tab) => tab.id === activeTabId)) {
          return state;
        }

        return {
          activePreviewTabIdByProject: {
            ...state.activePreviewTabIdByProject,
            [normalizedProjectId]: existingTabs[0]?.id ?? null,
          },
        };
      }

      const initialTab = createPreviewTabState(initialUrl);
      return {
        previewTabsByProject: {
          ...state.previewTabsByProject,
          [normalizedProjectId]: [initialTab],
        },
        activePreviewTabIdByProject: {
          ...state.activePreviewTabIdByProject,
          [normalizedProjectId]: initialTab.id,
        },
      };
    });
  },
  createPreviewTab: (projectId, initialUrl = "") => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return null;
    }

    const nextTab = createPreviewTabState(initialUrl);
    set((state) => ({
      previewTabsByProject: {
        ...state.previewTabsByProject,
        [normalizedProjectId]: [
          ...(state.previewTabsByProject[normalizedProjectId] ?? []),
          nextTab,
        ],
      },
      activePreviewTabIdByProject: {
        ...state.activePreviewTabIdByProject,
        [normalizedProjectId]: nextTab.id,
      },
    }));

    return nextTab.id;
  },
  updatePreviewTab: (projectId, tabId, updater) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedProjectId || !normalizedTabId) {
      return;
    }

    set((state) => {
      const tabs = state.previewTabsByProject[normalizedProjectId] ?? [];
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
        previewTabsByProject: {
          ...state.previewTabsByProject,
          [normalizedProjectId]: nextTabs,
        },
      };
    });
  },
  closePreviewTab: (projectId, tabId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedProjectId || !normalizedTabId) {
      return null;
    }

    const existingTabs = get().previewTabsByProject[normalizedProjectId] ?? [];
    if (existingTabs.length <= 1) {
      return (
        resolveActivePreviewTab(
          existingTabs,
          get().activePreviewTabIdByProject[normalizedProjectId],
        )?.id ?? null
      );
    }

    const closingIndex = existingTabs.findIndex(
      (tab) => tab.id === normalizedTabId,
    );
    if (closingIndex === -1) {
      return (
        resolveActivePreviewTab(
          existingTabs,
          get().activePreviewTabIdByProject[normalizedProjectId],
        )?.id ?? null
      );
    }

    const remainingTabs = existingTabs.filter(
      (tab) => tab.id !== normalizedTabId,
    );
    const currentActiveTabId =
      get().activePreviewTabIdByProject[normalizedProjectId] ?? null;
    const nextActiveTab =
      currentActiveTabId === normalizedTabId
        ? (remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ??
          null)
        : resolveActivePreviewTab(remainingTabs, currentActiveTabId);
    const nextActiveTabId = nextActiveTab?.id ?? null;

    set((state) => {
      const nextPreviewLoading = { ...state.previewLoading };
      delete nextPreviewLoading[normalizedTabId];

      return {
        previewLoading: nextPreviewLoading,
        previewTabsByProject: {
          ...state.previewTabsByProject,
          [normalizedProjectId]: remainingTabs,
        },
        activePreviewTabIdByProject: {
          ...state.activePreviewTabIdByProject,
          [normalizedProjectId]: nextActiveTabId,
        },
      };
    });

    return nextActiveTabId;
  },
  setActivePreviewTab: (projectId, tabId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const tabs = state.previewTabsByProject[normalizedProjectId] ?? [];
      const nextActiveTabId =
        tabId && tabs.some((tab) => tab.id === tabId)
          ? tabId
          : (tabs[0]?.id ?? null);

      return {
        activePreviewTabIdByProject: {
          ...state.activePreviewTabIdByProject,
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
    const sessionId = getPreviewTerminalSessionId(project.id);

    set((state) => ({
      outputPanelOpen: true,
      previewError: null,
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
    const sessionId = getPreviewTerminalSessionId(project.id);

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
      const panelOpen = get().projectTerminalPanelOpen;
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
          projectTerminalPanelOpen: true,
        }));
        return;
      }

      set({ projectTerminalPanelOpen: false });
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
        projectTerminalPanelOpen: true,
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

      delete nextTerminalOutput[sessionId];
      delete nextTerminalStatus[sessionId];
      delete nextTerminalTransport[sessionId];
      delete nextTerminalShell[sessionId];
      delete nextTerminalSessionNames[sessionId];

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
        projectTerminalPanelOpen:
          nextSessionIds.length > 0 ? state.projectTerminalPanelOpen : false,
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
          messagesByChatId: {},
          panelSizes: DEFAULT_PANEL_SIZES,
          panelVisibility: DEFAULT_PANEL_VISIBILITY,
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
            messagesByChatId: {},
            panelSizes: DEFAULT_PANEL_SIZES,
            panelVisibility: DEFAULT_PANEL_VISIBILITY,
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

    set({
      projects: loaded.projects,
      activeProjectId: nextActiveProjectId,
      chats: loaded.chats,
      activeChatIdByProject: Object.fromEntries(
        loaded.projects.map((project) => [
          project.id,
          ensureActiveChatForProject(
            loaded.chats,
            project.id,
            loaded.activeChatIdByProject[project.id] ?? null,
          ),
        ]),
      ),
      messagesByChatId: loaded.messagesByChatId,
      panelSizes: loaded.panelSizes,
      panelVisibility: {
        ...loaded.panelVisibility,
        middle: true,
      },
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
      draftChatIdByProject,
      messagesByChatId,
      panelSizes,
      panelVisibility,
      projects,
      settings,
      stateHydrated,
    } = get();
    if (!stateHydrated) return;

    const persistedChats = chats.filter((chat) => {
      if (draftChatIdByProject[chat.projectId] === chat.id) {
        return false;
      }

      return (messagesByChatId[chat.id]?.length ?? 0) > 0;
    });
    const persistedMessagesByChatId = Object.fromEntries(
      persistedChats.map((chat) => [chat.id, messagesByChatId[chat.id] ?? []]),
    );

    const nextState: PersistedIdeState = {
      activeProjectId: ensureActiveProject(projects, activeProjectId),
      activeChatIdByProject: Object.fromEntries(
        projects.map((project) => [
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
      messagesByChatId: persistedMessagesByChatId,
      panelSizes,
      panelVisibility: {
        ...panelVisibility,
        middle: true,
      },
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
