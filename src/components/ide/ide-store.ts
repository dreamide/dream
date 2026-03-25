import type { UIMessage } from "ai";
import { create } from "zustand";
import { getDesktopApi } from "@/lib/electron";
import {
  createProjectConfig,
  createThreadConfig,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  getConnectedProviders,
  getDefaultModelSelection,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import { dedupeModelOptions } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  PanelVisibility,
  PersistedIdeState,
  PreviewTabState,
  ProjectConfig,
  ThreadConfig,
  ThreadSortOrder,
} from "@/types/ide";
import {
  ensureActiveProject,
  ensureActiveThreadForProject,
  getThreadsForProject,
  mergePersistedState,
} from "./ide-state";
import {
  type CodexLoginStatus,
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
  threads: ThreadConfig[];
  activeThreadIdByProject: Record<string, string | null>;
  threadSort: ThreadSortOrder;
  panelVisibility: PanelVisibility;
  settings: AppSettings;
  chats: Record<string, UIMessage[]>;

  // Runtime state
  streamingThreadIds: Record<string, boolean>;
  terminalOutput: Record<string, string>;
  terminalStatus: Record<string, "running" | "stopped">;
  terminalTransport: Record<string, "pty" | "pipe">;
  terminalShell: Record<string, string>;
  projectTerminalSessionIds: Record<string, string[]>;
  activeTerminalSessionIdByProject: Record<string, string | null>;
  outputPanelOpen: boolean;
  autoAcceptEdits: boolean;
  previewError: string | null;
  previewLoading: Record<string, boolean>;
  previewTabsByProject: Record<string, PreviewTabState[]>;
  activePreviewTabIdByProject: Record<string, string | null>;
  rightPanelView: RightPanelView;
  stateHydrated: boolean;
  isMacOs: boolean;
  isElectron: boolean;
  appReady: boolean;

  // Settings dialog state
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  providerSetupTarget: AiProvider | null;
  modelSearchQuery: string;
  codexLoginStatus: CodexLoginStatus;
  providerModels: {
    openai: ProviderModelState;
    anthropic: ProviderModelState;
    gemini: ProviderModelState;
    fetchedAt: string | null;
  };

  // Derived (computed inline via getters, but activeProject is common enough)
  getActiveProject: () => ProjectConfig | null;
  getThreadsForProject: (projectId: string) => ThreadConfig[];
  getActiveThread: () => ThreadConfig | null;
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
  addThread: (projectId: string, title?: string) => void;
  setActiveThreadId: (projectId: string, threadId: string | null) => void;
  updateThread: (
    threadId: string,
    updater: (thread: ThreadConfig) => ThreadConfig,
  ) => void;
  closeThread: (threadId: string) => void;
  archiveThread: (threadId: string) => void;
  setMessagesForThread: (threadId: string, messages: UIMessage[]) => void;
  setThreadSort: (sortOrder: ThreadSortOrder) => void;

  // Actions – panels
  togglePanel: (panel: keyof PanelVisibility) => void;
  setOutputPanelOpen: (open: boolean) => void;
  setAutoAcceptEdits: (value: boolean) => void;
  setRightPanelView: (view: RightPanelView) => void;

  // Actions – settings
  setSettings: (
    updater: AppSettings | ((prev: AppSettings) => AppSettings),
  ) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setProviderSetupTarget: (target: AiProvider | null) => void;
  setModelSearchQuery: (query: string) => void;

  // Actions – provider management
  connectProvider: (provider: AiProvider) => void;
  disconnectProvider: (provider: AiProvider) => void;
  toggleProviderModel: (provider: AiProvider, model: string) => void;
  openProviderSetup: (provider: AiProvider) => void;
  submitProviderSetup: (provider: AiProvider) => void;
  refreshCodexLoginStatus: () => Promise<void>;
  refreshProviderModels: (creds: {
    anthropicAccessToken: string;
    anthropicAccessTokenExpiresAt: number | null;
    anthropicAuthMode: "apiKey" | "claudeCode";
    anthropicApiKey: string;
    anthropicRefreshToken: string;
    geminiApiKey: string;
    openAiApiKey: string;
    openAiAuthMode: "apiKey" | "codex";
  }) => Promise<void>;
  setProviderModels: (
    updater:
      | IdeState["providerModels"]
      | ((prev: IdeState["providerModels"]) => IdeState["providerModels"]),
  ) => void;
  setCodexLoginStatus: (status: CodexLoginStatus) => void;

  // Actions – runtime
  appendTerminalOutput: (projectId: string, chunk: string) => void;
  clearTerminalOutput: (projectId: string) => void;
  setTerminalStatus: (projectId: string, status: "running" | "stopped") => void;
  setTerminalTransport: (projectId: string, transport: "pty" | "pipe") => void;
  setTerminalShell: (projectId: string, shell: string) => void;
  setThreadStreaming: (threadId: string, streaming: boolean) => void;
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
  anthropic: { error: null, loading: false, models: [], source: "unavailable" },
  fetchedAt: null,
  gemini: { error: null, loading: false, models: [], source: "unavailable" },
  openai: { error: null, loading: false, models: [], source: "unavailable" },
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

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  projects: [],
  activeProjectId: null,
  threads: [],
  activeThreadIdByProject: {},
  threadSort: "recent",
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  settings: DEFAULT_SETTINGS,
  chats: {},

  // ── Runtime state ───────────────────────────────────────────────────
  streamingThreadIds: {},
  terminalOutput: {},
  terminalStatus: {},
  terminalTransport: {},
  terminalShell: {},
  projectTerminalSessionIds: {},
  activeTerminalSessionIdByProject: {},
  outputPanelOpen: false,
  autoAcceptEdits: false,
  previewError: null,
  previewLoading: {},
  previewTabsByProject: {},
  activePreviewTabIdByProject: {},
  rightPanelView: "explorer",
  stateHydrated: false,
  isMacOs: false,
  isElectron: false,
  appReady: false,

  // ── Settings dialog state ───────────────────────────────────────────
  settingsOpen: false,
  settingsSection: "appearance",
  providerSetupTarget: null,
  modelSearchQuery: "",
  codexLoginStatus: {
    authMode: "unknown",
    loading: false,
    loggedIn: false,
    message: "",
  },
  providerModels: DEFAULT_PROVIDER_MODELS,

  // ── Getters ─────────────────────────────────────────────────────────
  getActiveProject: () => {
    const { activeProjectId, projects } = get();
    return projects.find((project) => project.id === activeProjectId) ?? null;
  },

  getThreadsForProject: (projectId) => {
    const { threads } = get();
    return getThreadsForProject(threads, projectId);
  },

  getActiveThread: () => {
    const { activeThreadIdByProject, getActiveProject, threads } = get();
    const project = getActiveProject();
    if (!project) {
      return null;
    }

    const activeThreadId = activeThreadIdByProject[project.id] ?? null;
    return threads.find((thread) => thread.id === activeThreadId) ?? null;
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
      const nextActiveThreadIdByProject = Object.fromEntries(
        projects.map((project) => [
          project.id,
          ensureActiveThreadForProject(
            state.threads,
            project.id,
            state.activeThreadIdByProject[project.id] ?? null,
          ),
        ]),
      );

      return {
        activeProjectId: nextActiveProjectId,
        activeThreadIdByProject: nextActiveThreadIdByProject,
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
      const nextThread = createThreadConfig(nextProject);

      return {
        activeProjectId: nextProject.id,
        activeThreadIdByProject: {
          ...state.activeThreadIdByProject,
          [nextProject.id]: nextThread.id,
        },
        chats: {
          ...state.chats,
          [nextThread.id]: [],
        },
        projects: [...state.projects, nextProject],
        threads: [...state.threads, nextThread],
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
      const nextThreads = state.threads.filter(
        (thread) => thread.projectId !== projectId,
      );
      const nextChats = Object.fromEntries(
        Object.entries(state.chats).filter(([threadId]) =>
          nextThreads.some((thread) => thread.id === threadId),
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
      const nextPreviewLoading = { ...state.previewLoading };

      delete nextPreviewTabsByProject[projectId];
      delete nextActivePreviewTabIdByProject[projectId];
      for (const tab of previewTabs) {
        delete nextPreviewLoading[tab.id];
      }

      return {
        activeProjectId: nextActiveProjectId,
        activeThreadIdByProject: Object.fromEntries(
          nextProjects.map((project) => [
            project.id,
            ensureActiveThreadForProject(
              nextThreads,
              project.id,
              state.activeThreadIdByProject[project.id] ?? null,
            ),
          ]),
        ),
        chats: nextChats,
        previewLoading: nextPreviewLoading,
        previewTabsByProject: nextPreviewTabsByProject,
        activePreviewTabIdByProject: nextActivePreviewTabIdByProject,
        projects: nextProjects,
        threads: nextThreads,
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

  addThread: (projectId, title) => {
    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }

      const defaultSelection = getDefaultModelSelection(state.settings);
      const nextThread = createThreadConfig(project, {
        model: defaultSelection.model || project.model,
        provider: defaultSelection.model
          ? defaultSelection.provider
          : project.provider,
        title,
      });

      return {
        activeProjectId: projectId,
        activeThreadIdByProject: {
          ...state.activeThreadIdByProject,
          [projectId]: nextThread.id,
        },
        chats: {
          ...state.chats,
          [nextThread.id]: [],
        },
        threads: [...state.threads, nextThread],
      };
    });
  },

  setActiveThreadId: (projectId, threadId) => {
    set((state) => ({
      activeThreadIdByProject: {
        ...state.activeThreadIdByProject,
        [projectId]: ensureActiveThreadForProject(
          state.threads,
          projectId,
          threadId,
        ),
      },
    }));
  },

  updateThread: (threadId, updater) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? updater(thread) : thread,
      ),
    }));
  },

  closeThread: (threadId) => {
    set((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) {
        return state;
      }

      const nextThreads = state.threads.filter((item) => item.id !== threadId);
      const nextChats = { ...state.chats };
      delete nextChats[threadId];

      return {
        activeThreadIdByProject: {
          ...state.activeThreadIdByProject,
          [thread.projectId]: ensureActiveThreadForProject(
            nextThreads,
            thread.projectId,
            state.activeThreadIdByProject[thread.projectId] === threadId
              ? null
              : (state.activeThreadIdByProject[thread.projectId] ?? null),
          ),
        },
        chats: nextChats,
        threads: nextThreads,
      };
    });
  },

  archiveThread: (threadId) => {
    set((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) {
        return state;
      }

      const archivedAt = new Date().toISOString();
      const nextThreads = state.threads.map((item) =>
        item.id === threadId ? { ...item, archivedAt } : item,
      );

      return {
        activeThreadIdByProject: {
          ...state.activeThreadIdByProject,
          [thread.projectId]: ensureActiveThreadForProject(
            nextThreads,
            thread.projectId,
            state.activeThreadIdByProject[thread.projectId] === threadId
              ? null
              : (state.activeThreadIdByProject[thread.projectId] ?? null),
          ),
        },
        threads: nextThreads,
      };
    });
  },

  setMessagesForThread: (threadId, messages) => {
    set((state) => {
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread) {
        return state;
      }
      const messagesChanged = !areMessagesEqual(
        state.chats[threadId],
        messages,
      );

      if (!messagesChanged) {
        return state;
      }

      return {
        chats: { ...state.chats, [threadId]: messages },
        threads: state.threads.map((item) =>
          item.id === threadId
            ? {
                ...item,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      };
    });
  },

  setThreadSort: (threadSort) => set({ threadSort }),

  // ── Actions: panels ─────────────────────────────────────────────────
  togglePanel: (panel) => {
    set((state) => ({
      panelVisibility: {
        ...state.panelVisibility,
        [panel]: !state.panelVisibility[panel],
      },
    }));
  },
  setOutputPanelOpen: (open) => set({ outputPanelOpen: open }),
  setAutoAcceptEdits: (value) => set({ autoAcceptEdits: value }),
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
  setProviderSetupTarget: (target) => set({ providerSetupTarget: target }),
  setModelSearchQuery: (query) => set({ modelSearchQuery: query }),

  // ── Actions: provider management ────────────────────────────────────
  connectProvider: (provider) => {
    set((state) => {
      const current = getConnectedProviders(state.settings);
      if (current.includes(provider)) return state;
      return {
        settings: {
          ...state.settings,
          connectedProviders: [...current, provider],
        },
      };
    });
  },

  disconnectProvider: (provider) => {
    set((state) => {
      const current = getConnectedProviders(state.settings);
      if (!current.includes(provider)) return state;

      const baseSettings = {
        ...state.settings,
        connectedProviders: current.filter((p) => p !== provider),
      };

      let nextSettings = baseSettings;
      if (provider === "openai") {
        nextSettings = {
          ...baseSettings,
          openAiSelectedModels: [],
        };
      } else if (provider === "gemini") {
        nextSettings = {
          ...baseSettings,
          geminiSelectedModels: [],
        };
      } else {
        nextSettings = {
          ...baseSettings,
          anthropicAccessToken: "",
          anthropicAccessTokenExpiresAt: null,
          anthropicRefreshToken: "",
          anthropicSelectedModels: [],
        };
      }

      return {
        settings: {
          ...nextSettings,
          defaultModel: getPreferredDefaultModel(nextSettings),
        },
      };
    });
  },

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
      if (provider === "gemini") {
        const current = dedupeModels(prev.geminiSelectedModels);
        const next = current.includes(model)
          ? current.filter((v) => v !== model)
          : [...current, model];
        const nextSettings = {
          ...prev,
          geminiSelectedModels: next,
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

  openProviderSetup: (provider) => {
    set({ providerSetupTarget: provider });
    const { settings } = get();
    if (provider === "openai" && settings.openAiAuthMode === "codex") {
      void get().refreshCodexLoginStatus();
    }
  },

  submitProviderSetup: (provider) => {
    const { connectProvider: connect, refreshProviderModels, settings } = get();
    connect(provider);
    void refreshProviderModels({
      anthropicAccessToken: settings.anthropicAccessToken,
      anthropicAccessTokenExpiresAt: settings.anthropicAccessTokenExpiresAt,
      anthropicAuthMode: settings.anthropicAuthMode,
      anthropicApiKey: settings.anthropicApiKey,
      anthropicRefreshToken: settings.anthropicRefreshToken,
      geminiApiKey: settings.geminiApiKey,
      openAiApiKey: settings.openAiApiKey,
      openAiAuthMode: settings.openAiAuthMode,
    });
    set({ providerSetupTarget: null });
  },

  refreshCodexLoginStatus: async () => {
    set((state) => ({
      codexLoginStatus: { ...state.codexLoginStatus, loading: true },
    }));

    try {
      const response = await fetch("/api/codex-auth");
      if (!response.ok)
        throw new Error(`Status check failed (${response.status})`);

      const payload = (await response.json()) as {
        authMode: string;
        loggedIn: boolean;
        message: string;
      };

      set({
        codexLoginStatus: {
          authMode: payload.authMode ?? "unknown",
          loading: false,
          loggedIn: Boolean(payload.loggedIn),
          message: payload.message ?? "",
        },
      });
    } catch {
      set({
        codexLoginStatus: {
          authMode: "unknown",
          loading: false,
          loggedIn: false,
          message: "Unable to read Codex login status.",
        },
      });
    }
  },

  refreshProviderModels: async ({
    anthropicAccessToken,
    anthropicAccessTokenExpiresAt,
    anthropicAuthMode,
    anthropicApiKey,
    anthropicRefreshToken,
    geminiApiKey,
    openAiApiKey,
    openAiAuthMode,
  }) => {
    set((state) => ({
      providerModels: {
        ...state.providerModels,
        anthropic: {
          ...state.providerModels.anthropic,
          error: null,
          loading: true,
        },
        gemini: { ...state.providerModels.gemini, error: null, loading: true },
        openai: { ...state.providerModels.openai, error: null, loading: true },
      },
    }));

    try {
      const response = await fetch("/api/provider-models", {
        body: JSON.stringify({
          anthropicAccessToken,
          anthropicAccessTokenExpiresAt,
          anthropicAuthMode,
          anthropicApiKey,
          anthropicRefreshToken,
          geminiApiKey,
          openAiApiKey,
          openAiAuthMode,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok)
        throw new Error(`Model fetch failed (${response.status}).`);

      const payload = (await response.json()) as ProviderModelsResponse;
      const nextOpenAiModels = dedupeModelOptions(payload.openai.models);
      const nextAnthropicModels = dedupeModelOptions(payload.anthropic.models);
      const nextGeminiModels = dedupeModelOptions(payload.gemini.models);
      const nextOpenAiModelIds = nextOpenAiModels.map((model) => model.id);
      const nextAnthropicModelIds = nextAnthropicModels.map(
        (model) => model.id,
      );
      const nextGeminiModelIds = nextGeminiModels.map((model) => model.id);

      set({
        providerModels: {
          anthropic: {
            error: payload.anthropic.error ?? null,
            loading: false,
            models: nextAnthropicModels,
            source: payload.anthropic.source,
          },
          fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
          gemini: {
            error: payload.gemini.error ?? null,
            loading: false,
            models: nextGeminiModels,
            source: payload.gemini.source,
          },
          openai: {
            error: payload.openai.error ?? null,
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
        const currentGeminiSelected = dedupeModels(
          prev.geminiSelectedModels,
        ).filter((m) => nextGeminiModelIds.includes(m));

        const openAiSelectedModels =
          currentOpenAiSelected.length > 0 ? currentOpenAiSelected : [];
        const anthropicSelectedModels =
          currentAnthropicSelected.length > 0 ? currentAnthropicSelected : [];
        const geminiSelectedModels =
          currentGeminiSelected.length > 0 ? currentGeminiSelected : [];
        const nextSettings = {
          ...prev,
          anthropicSelectedModels,
          geminiSelectedModels,
          openAiSelectedModels,
        };
        const defaultModel = getPreferredDefaultModel(nextSettings);

        if (
          defaultModel === prev.defaultModel &&
          openAiSelectedModels.length === prev.openAiSelectedModels.length &&
          anthropicSelectedModels.length ===
            prev.anthropicSelectedModels.length &&
          geminiSelectedModels.length === prev.geminiSelectedModels.length &&
          openAiSelectedModels.every(
            (m, i) => prev.openAiSelectedModels[i] === m,
          ) &&
          anthropicSelectedModels.every(
            (m, i) => prev.anthropicSelectedModels[i] === m,
          ) &&
          geminiSelectedModels.every(
            (m, i) => prev.geminiSelectedModels[i] === m,
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
            loading: false,
            models: state.providerModels.anthropic.models,
            source: state.providerModels.anthropic.source,
          },
          fetchedAt: state.providerModels.fetchedAt,
          gemini: {
            error: message,
            loading: false,
            models: state.providerModels.gemini.models,
            source: state.providerModels.gemini.source,
          },
          openai: {
            error: message,
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

  setCodexLoginStatus: (status) => set({ codexLoginStatus: status }),

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

  setThreadStreaming: (threadId, streaming) =>
    set((state) => {
      const next = { ...state.streamingThreadIds };
      if (streaming) {
        next[threadId] = true;
      } else {
        delete next[threadId];
      }
      return { streamingThreadIds: next };
    }),
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
      const activeSessionId =
        get().activeTerminalSessionIdByProject[projectId] ??
        existingSessionIds[existingSessionIds.length - 1] ??
        null;

      if (activeSessionId) {
        set((state) => ({
          activeProjectId: projectId,
          activeTerminalSessionIdByProject: {
            ...state.activeTerminalSessionIdByProject,
            [projectId]: activeSessionId,
          },
        }));
      }
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

    set((state) => ({
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
      terminalOutput: {
        ...state.terminalOutput,
        [sessionId]: "",
      },
      terminalStatus: {
        ...state.terminalStatus,
        [sessionId]: "running",
      },
    }));

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

      delete nextTerminalOutput[sessionId];
      delete nextTerminalStatus[sessionId];
      delete nextTerminalTransport[sessionId];
      delete nextTerminalShell[sessionId];

      return {
        terminalOutput: nextTerminalOutput,
        terminalStatus: nextTerminalStatus,
        terminalTransport: nextTerminalTransport,
        terminalShell: nextTerminalShell,
        projectTerminalSessionIds: {
          ...state.projectTerminalSessionIds,
          [projectId]: nextSessionIds,
        },
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
          activeThreadIdByProject: {},
          chats: {},
          panelVisibility: DEFAULT_PANEL_VISIBILITY,
          projects: [],
          settings: DEFAULT_SETTINGS,
          threadSort: "recent",
          threads: [],
        };
      } else {
        try {
          loaded = mergePersistedState(
            JSON.parse(rawState) as PersistedIdeState,
          );
        } catch {
          loaded = {
            activeProjectId: null,
            activeThreadIdByProject: {},
            chats: {},
            panelVisibility: DEFAULT_PANEL_VISIBILITY,
            projects: [],
            settings: DEFAULT_SETTINGS,
            threadSort: "recent",
            threads: [],
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
      threads: loaded.threads,
      activeThreadIdByProject: Object.fromEntries(
        loaded.projects.map((project) => [
          project.id,
          ensureActiveThreadForProject(
            loaded.threads,
            project.id,
            loaded.activeThreadIdByProject[project.id] ?? null,
          ),
        ]),
      ),
      panelVisibility: loaded.panelVisibility,
      settings: loaded.settings,
      threadSort: loaded.threadSort,
      chats: loaded.chats,
      stateHydrated: true,
    });
  },

  persist: () => {
    const {
      projects,
      activeProjectId,
      threads,
      activeThreadIdByProject,
      threadSort,
      panelVisibility,
      settings,
      chats,
      stateHydrated,
    } = get();
    if (!stateHydrated) return;

    const nextState: PersistedIdeState = {
      activeProjectId: ensureActiveProject(projects, activeProjectId),
      activeThreadIdByProject: Object.fromEntries(
        projects.map((project) => [
          project.id,
          ensureActiveThreadForProject(
            threads,
            project.id,
            activeThreadIdByProject[project.id] ?? null,
          ),
        ]),
      ),
      chats,
      panelVisibility,
      projects,
      settings,
      threadSort,
      threads,
    };

    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.saveState(nextState);
    } else {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState));
    }
  },
}));
