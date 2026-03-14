import type { UIMessage } from "ai";
import { create } from "zustand";
import { getDesktopApi } from "@/lib/electron";
import {
  createProjectConfig,
  createThreadConfig,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  getConnectedProviders,
} from "@/lib/ide-defaults";
import { dedupeModelOptions } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  PanelVisibility,
  PersistedIdeState,
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
  terminalOutput: Record<string, string>;
  terminalStatus: Record<string, "running" | "stopped">;
  terminalTransport: Record<string, "pty" | "pipe">;
  terminalShell: Record<string, string>;
  projectTerminalSessionIds: Record<string, string[]>;
  activeTerminalSessionIdByProject: Record<string, string | null>;
  outputPanelOpen: boolean;
  previewError: string | null;
  previewLoading: Record<string, boolean>;
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
    anthropicAuthMode: "apiKey" | "claudeProMax";
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
  setPreviewError: (error: string | null) => void;
  setPreviewLoading: (projectId: string, loading: boolean) => void;
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

  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
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
  terminalOutput: {},
  terminalStatus: {},
  terminalTransport: {},
  terminalShell: {},
  projectTerminalSessionIds: {},
  activeTerminalSessionIdByProject: {},
  outputPanelOpen: false,
  previewError: null,
  previewLoading: {},
  stateHydrated: false,
  isMacOs: false,
  isElectron: false,
  appReady: false,

  // ── Settings dialog state ───────────────────────────────────────────
  settingsOpen: false,
  settingsSection: "providers",
  providerSetupTarget: null,
  modelSearchQuery: "",
  codexLoginStatus: {
    authMode: "unknown",
    loading: false,
    loggedIn: false,
    message: "",
  },
  providerModels: DEFAULT_PROVIDER_MODELS,

  // ── Derived ─────────────────────────────────────────────────────────
  getActiveProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId) ?? null;
  },
  getThreadsForProject: (projectId) => {
    const { threadSort, threads } = get();
    return getThreadsForProject(threads, projectId, threadSort);
  },
  getActiveThread: () => {
    const { activeProjectId, activeThreadIdByProject, threads } = get();
    if (!activeProjectId) {
      return null;
    }

    const activeThreadId = activeThreadIdByProject[activeProjectId] ?? null;
    if (!activeThreadId) {
      return null;
    }

    return threads.find((thread) => thread.id === activeThreadId) ?? null;
  },

  // ── Actions: projects ───────────────────────────────────────────────
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (id) => {
    set((state) => {
      if (!id) {
        return { activeProjectId: null };
      }

      return {
        activeProjectId: id,
        activeThreadIdByProject: {
          ...state.activeThreadIdByProject,
          [id]: ensureActiveThreadForProject(
            state.threads,
            id,
            state.activeThreadIdByProject[id] ?? null,
          ),
        },
      };
    });
  },

  addProject: (path) => {
    const { projects, settings } = get();
    const existing = projects.find((p) => p.path === path);
    if (existing) {
      get().setActiveProjectId(existing.id);
      return;
    }
    const nextProject = createProjectConfig(path, settings);
    const nextThread = createThreadConfig(nextProject);
    set((state) => ({
      projects: [...projects, nextProject],
      activeProjectId: nextProject.id,
      activeThreadIdByProject: {
        ...state.activeThreadIdByProject,
        [nextProject.id]: nextThread.id,
      },
      chats: {
        ...state.chats,
        [nextThread.id]: [],
      },
      threads: [...state.threads, nextThread],
    }));
  },

  closeProject: (projectId) => {
    const desktopApi = getDesktopApi();
    const previewTerminalSessionId = getPreviewTerminalSessionId(projectId);
    const projectTerminalSessionIds =
      get().projectTerminalSessionIds[projectId] ?? [];
    if (desktopApi) {
      void desktopApi.stopTerminal(previewTerminalSessionId);
      for (const sessionId of projectTerminalSessionIds) {
        void desktopApi.stopTerminal(sessionId);
      }
    }

    set((state) => {
      const nextProjects = state.projects.filter((p) => p.id !== projectId);
      const removedThreadIds = state.threads
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => thread.id);
      const nextThreads = state.threads.filter(
        (thread) => thread.projectId !== projectId,
      );
      const nextChats = { ...state.chats };
      for (const threadId of removedThreadIds) {
        delete nextChats[threadId];
      }
      const nextActiveThreadIdByProject = { ...state.activeThreadIdByProject };
      delete nextActiveThreadIdByProject[projectId];
      const nextTerminalOutput = { ...state.terminalOutput };
      delete nextTerminalOutput[previewTerminalSessionId];
      const nextTerminalStatus = { ...state.terminalStatus };
      delete nextTerminalStatus[previewTerminalSessionId];
      const nextTerminalTransport = { ...state.terminalTransport };
      delete nextTerminalTransport[previewTerminalSessionId];
      const nextTerminalShell = { ...state.terminalShell };
      delete nextTerminalShell[previewTerminalSessionId];
      const nextProjectTerminalSessionIds = {
        ...state.projectTerminalSessionIds,
      };
      const nextActiveTerminalSessionIdByProject = {
        ...state.activeTerminalSessionIdByProject,
      };

      delete nextProjectTerminalSessionIds[projectId];
      delete nextActiveTerminalSessionIdByProject[projectId];

      for (const sessionId of state.projectTerminalSessionIds[projectId] ??
        []) {
        delete nextTerminalOutput[sessionId];
        delete nextTerminalStatus[sessionId];
        delete nextTerminalTransport[sessionId];
        delete nextTerminalShell[sessionId];
      }

      return {
        projects: nextProjects,
        activeProjectId: ensureActiveProject(
          nextProjects,
          state.activeProjectId,
        ),
        activeThreadIdByProject: nextActiveThreadIdByProject,
        chats: nextChats,
        terminalOutput: nextTerminalOutput,
        terminalStatus: nextTerminalStatus,
        terminalTransport: nextTerminalTransport,
        terminalShell: nextTerminalShell,
        projectTerminalSessionIds: nextProjectTerminalSessionIds,
        activeTerminalSessionIdByProject: nextActiveTerminalSessionIdByProject,
        threads: nextThreads,
      };
    });
  },

  updateProject: (projectId, updater) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? updater(p) : p,
      ),
    }));
  },

  addThread: (projectId, title) => {
    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return state;
      }

      const thread = createThreadConfig(project, { title });
      return {
        activeProjectId: projectId,
        activeThreadIdByProject: {
          ...state.activeThreadIdByProject,
          [projectId]: thread.id,
        },
        chats: {
          ...state.chats,
          [thread.id]: [],
        },
        threads: [thread, ...state.threads],
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
      threads: state.threads.map((thread) => {
        if (thread.id !== threadId) {
          return thread;
        }

        const nextThread = updater(thread);
        return {
          ...nextThread,
          updatedAt: new Date().toISOString(),
        };
      }),
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
      if (!thread || thread.archivedAt !== null) {
        return state;
      }

      const archivedAt = new Date().toISOString();
      const nextThreads = state.threads.map((item) =>
        item.id === threadId
          ? {
              ...item,
              archivedAt,
              updatedAt: archivedAt,
            }
          : item,
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

      const nextActiveThreadIdByProject = {
        ...state.activeThreadIdByProject,
        [thread.projectId]: threadId,
      };
      const messagesChanged = !areMessagesEqual(
        state.chats[threadId],
        messages,
      );

      if (!messagesChanged) {
        if (state.activeThreadIdByProject[thread.projectId] === threadId) {
          return state;
        }

        return {
          activeThreadIdByProject: nextActiveThreadIdByProject,
        };
      }

      return {
        activeThreadIdByProject: nextActiveThreadIdByProject,
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

      if (provider === "openai") {
        return {
          settings: {
            ...state.settings,
            connectedProviders: current.filter((p) => p !== provider),
            defaultOpenAiModel: "",
            openAiSelectedModels: [],
          },
        };
      }
      if (provider === "gemini") {
        return {
          settings: {
            ...state.settings,
            connectedProviders: current.filter((p) => p !== provider),
            defaultGeminiModel: "",
            geminiSelectedModels: [],
          },
        };
      }
      return {
        settings: {
          ...state.settings,
          anthropicSelectedModels: [],
          connectedProviders: current.filter((p) => p !== provider),
          defaultAnthropicModel: "",
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
        return {
          settings: {
            ...prev,
            defaultOpenAiModel: next.includes(prev.defaultOpenAiModel)
              ? prev.defaultOpenAiModel
              : (next[0] ?? ""),
            openAiSelectedModels: next,
          },
        };
      }
      if (provider === "gemini") {
        const current = dedupeModels(prev.geminiSelectedModels);
        const next = current.includes(model)
          ? current.filter((v) => v !== model)
          : [...current, model];
        return {
          settings: {
            ...prev,
            defaultGeminiModel: next.includes(prev.defaultGeminiModel)
              ? prev.defaultGeminiModel
              : (next[0] ?? ""),
            geminiSelectedModels: next,
          },
        };
      }
      const current = dedupeModels(prev.anthropicSelectedModels);
      const next = current.includes(model)
        ? current.filter((v) => v !== model)
        : [...current, model];
      return {
        settings: {
          ...prev,
          anthropicSelectedModels: next,
          defaultAnthropicModel: next.includes(prev.defaultAnthropicModel)
            ? prev.defaultAnthropicModel
            : (next[0] ?? ""),
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

      if (payload.anthropic.oauth) {
        set((state) => ({
          settings: {
            ...state.settings,
            anthropicAccessToken: payload.anthropic.oauth?.accessToken ?? "",
            anthropicAccessTokenExpiresAt:
              payload.anthropic.oauth?.expiresAt ?? null,
            anthropicRefreshToken: payload.anthropic.oauth?.refreshToken ?? "",
          },
        }));
      }

      // Reconcile selected models
      set((state) => {
        const prev = state.settings;
        const currentOpenAiSelected = dedupeModels(
          prev.openAiSelectedModels,
        ).filter((m) => nextOpenAiModelIds.includes(m));
        const currentAnthropicSelected = dedupeModels(
          prev.anthropicSelectedModels,
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

        const defaultOpenAiModel = openAiSelectedModels.includes(
          prev.defaultOpenAiModel,
        )
          ? prev.defaultOpenAiModel
          : (openAiSelectedModels[0] ?? "");
        const defaultAnthropicModel = anthropicSelectedModels.includes(
          prev.defaultAnthropicModel,
        )
          ? prev.defaultAnthropicModel
          : (anthropicSelectedModels[0] ?? "");
        const defaultGeminiModel = geminiSelectedModels.includes(
          prev.defaultGeminiModel,
        )
          ? prev.defaultGeminiModel
          : (geminiSelectedModels[0] ?? "");

        if (
          defaultOpenAiModel === prev.defaultOpenAiModel &&
          defaultAnthropicModel === prev.defaultAnthropicModel &&
          defaultGeminiModel === prev.defaultGeminiModel &&
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
            ...prev,
            anthropicSelectedModels,
            defaultAnthropicModel,
            defaultGeminiModel,
            defaultOpenAiModel,
            geminiSelectedModels,
            openAiSelectedModels,
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

  setPreviewError: (error) => set({ previewError: error }),
  setPreviewLoading: (projectId, loading) => {
    set((state) => ({
      previewLoading: { ...state.previewLoading, [projectId]: loading },
    }));
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
