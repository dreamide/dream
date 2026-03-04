import type { UIMessage } from "ai";
import { create } from "zustand";
import {
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  createProjectConfig,
  getConnectedProviders,
  getDefaultModelForProvider,
  getModelsForProvider,
} from "@/lib/ide-defaults";
import { getDesktopApi } from "@/lib/electron";
import type {
  AiProvider,
  AppSettings,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
} from "@/types/ide";
import { ensureActiveProject, mergePersistedState } from "./ide-state";
import {
  type CodexLoginStatus,
  GLOBAL_TERMINAL_SESSION_ID,
  type ProviderModelState,
  type ProviderModelsResponse,
  STATE_STORAGE_KEY,
  type SettingsSection,
  dedupeModels,
} from "./ide-types";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface IdeState {
  // Persisted state
  projects: ProjectConfig[];
  activeProjectId: string | null;
  panelVisibility: PanelVisibility;
  settings: AppSettings;
  chats: Record<string, UIMessage[]>;

  // Runtime state
  runLogs: Record<string, string>;
  runnerStatus: Record<string, "running" | "stopped">;
  terminalStatus: Record<string, "running" | "stopped">;
  terminalShell: Record<string, string>;
  terminalPanelOpen: boolean;
  outputPanelOpen: boolean;
  previewError: string | null;
  stateHydrated: boolean;
  isMacOs: boolean;
  isElectron: boolean;

  // Settings dialog state
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  providerSetupTarget: AiProvider | null;
  modelSearchQuery: string;
  codexLoginStatus: CodexLoginStatus;
  providerModels: {
    openai: ProviderModelState;
    anthropic: ProviderModelState;
    fetchedAt: string | null;
  };

  // Derived (computed inline via getters, but activeProject is common enough)
  getActiveProject: () => ProjectConfig | null;

  // Actions – projects
  setProjects: (projects: ProjectConfig[]) => void;
  setActiveProjectId: (id: string | null) => void;
  addProject: (path: string) => void;
  closeProject: (projectId: string) => void;
  updateProject: (
    projectId: string,
    updater: (project: ProjectConfig) => ProjectConfig,
  ) => void;
  setMessagesForProject: (projectId: string, messages: UIMessage[]) => void;

  // Actions – panels
  togglePanel: (panel: keyof PanelVisibility) => void;
  setTerminalPanelOpen: (open: boolean) => void;
  setOutputPanelOpen: (open: boolean) => void;

  // Actions – settings
  setSettings: (updater: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
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
    anthropicApiKey: string;
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
  setRunnerStatus: (projectId: string, status: "running" | "stopped") => void;
  appendRunLog: (projectId: string, chunk: string) => void;
  setTerminalStatus: (projectId: string, status: "running" | "stopped") => void;
  setTerminalShell: (projectId: string, shell: string) => void;
  setPreviewError: (error: string | null) => void;
  setIsMacOs: (value: boolean) => void;
  setIsElectron: (value: boolean) => void;
  openExternalUrl: (url: string) => void;

  // Actions – runner
  startRunner: () => Promise<void>;
  stopRunner: () => Promise<void>;

  // Actions – terminal
  startActiveTerminal: (
    terminalRef: React.RefObject<import("@xterm/xterm").Terminal | null>,
  ) => Promise<void>;
  stopActiveTerminal: () => Promise<void>;

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
  openai: { error: null, loading: false, models: [], source: "unavailable" },
};

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  projects: [],
  activeProjectId: null,
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  settings: DEFAULT_SETTINGS,
  chats: {},

  // ── Runtime state ───────────────────────────────────────────────────
  runLogs: {},
  runnerStatus: {},
  terminalStatus: {},
  terminalShell: {},
  terminalPanelOpen: false,
  outputPanelOpen: false,
  previewError: null,
  stateHydrated: false,
  isMacOs: false,
  isElectron: false,

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

  // ── Actions: projects ───────────────────────────────────────────────
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (id) => set({ activeProjectId: id }),

  addProject: (path) => {
    const { projects, settings } = get();
    const existing = projects.find((p) => p.path === path);
    if (existing) {
      set({ activeProjectId: existing.id });
      return;
    }
    const next = createProjectConfig(path, settings);
    set({ projects: [...projects, next], activeProjectId: next.id });
  },

  closeProject: (projectId) => {
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.stopRunner(projectId);
    }

    set((state) => {
      const nextProjects = state.projects.filter((p) => p.id !== projectId);
      const nextChats = { ...state.chats };
      delete nextChats[projectId];
      const nextRunLogs = { ...state.runLogs };
      delete nextRunLogs[projectId];
      const nextRunnerStatus = { ...state.runnerStatus };
      delete nextRunnerStatus[projectId];
      const nextTerminalStatus = { ...state.terminalStatus };
      delete nextTerminalStatus[projectId];

      return {
        projects: nextProjects,
        activeProjectId: ensureActiveProject(nextProjects, state.activeProjectId),
        chats: nextChats,
        runLogs: nextRunLogs,
        runnerStatus: nextRunnerStatus,
        terminalStatus: nextTerminalStatus,
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

  setMessagesForProject: (projectId, messages) => {
    set((state) => ({
      chats: { ...state.chats, [projectId]: messages },
    }));
  },

  // ── Actions: panels ─────────────────────────────────────────────────
  togglePanel: (panel) => {
    set((state) => ({
      panelVisibility: {
        ...state.panelVisibility,
        [panel]: !state.panelVisibility[panel],
      },
    }));
  },
  setTerminalPanelOpen: (open) => set({ terminalPanelOpen: open }),
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
      anthropicApiKey: settings.anthropicApiKey,
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
      if (!response.ok) throw new Error(`Status check failed (${response.status})`);

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

  refreshProviderModels: async ({ anthropicApiKey, openAiApiKey, openAiAuthMode }) => {
    set((state) => ({
      providerModels: {
        ...state.providerModels,
        anthropic: { ...state.providerModels.anthropic, error: null, loading: true },
        openai: { ...state.providerModels.openai, error: null, loading: true },
      },
    }));

    try {
      const response = await fetch("/api/provider-models", {
        body: JSON.stringify({ anthropicApiKey, openAiApiKey, openAiAuthMode }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) throw new Error(`Model fetch failed (${response.status}).`);

      const payload = (await response.json()) as ProviderModelsResponse;
      const nextOpenAiModels = dedupeModels(payload.openai.models);
      const nextAnthropicModels = dedupeModels(payload.anthropic.models);

      set({
        providerModels: {
          anthropic: {
            error: payload.anthropic.error ?? null,
            loading: false,
            models: nextAnthropicModels,
            source: payload.anthropic.source,
          },
          fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
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
        const currentOpenAiSelected = dedupeModels(prev.openAiSelectedModels).filter(
          (m) => nextOpenAiModels.includes(m),
        );
        const currentAnthropicSelected = dedupeModels(prev.anthropicSelectedModels).filter(
          (m) => nextAnthropicModels.includes(m),
        );

        const openAiSelectedModels = currentOpenAiSelected.length > 0 ? currentOpenAiSelected : [];
        const anthropicSelectedModels =
          currentAnthropicSelected.length > 0 ? currentAnthropicSelected : [];

        const defaultOpenAiModel = openAiSelectedModels.includes(prev.defaultOpenAiModel)
          ? prev.defaultOpenAiModel
          : (openAiSelectedModels[0] ?? "");
        const defaultAnthropicModel = anthropicSelectedModels.includes(prev.defaultAnthropicModel)
          ? prev.defaultAnthropicModel
          : (anthropicSelectedModels[0] ?? "");

        if (
          defaultOpenAiModel === prev.defaultOpenAiModel &&
          defaultAnthropicModel === prev.defaultAnthropicModel &&
          openAiSelectedModels.length === prev.openAiSelectedModels.length &&
          anthropicSelectedModels.length === prev.anthropicSelectedModels.length &&
          openAiSelectedModels.every((m, i) => prev.openAiSelectedModels[i] === m) &&
          anthropicSelectedModels.every((m, i) => prev.anthropicSelectedModels[i] === m)
        ) {
          return state;
        }

        return {
          settings: {
            ...prev,
            anthropicSelectedModels,
            defaultAnthropicModel,
            defaultOpenAiModel,
            openAiSelectedModels,
          },
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to fetch models.";
      set((state) => ({
        providerModels: {
          anthropic: {
            error: message,
            loading: false,
            models: state.providerModels.anthropic.models,
            source: state.providerModels.anthropic.source,
          },
          fetchedAt: state.providerModels.fetchedAt,
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
  setRunnerStatus: (projectId, status) => {
    set((state) => ({
      runnerStatus: { ...state.runnerStatus, [projectId]: status },
    }));
  },

  appendRunLog: (projectId, chunk) => {
    set((state) => {
      const current = state.runLogs[projectId] ?? "";
      const next = `${current}${chunk}`;
      return { runLogs: { ...state.runLogs, [projectId]: next.slice(-150_000) } };
    });
  },

  setTerminalStatus: (projectId, status) => {
    set((state) => ({
      terminalStatus: { ...state.terminalStatus, [projectId]: status },
    }));
  },

  setTerminalShell: (projectId, shell) => {
    set((state) => ({
      terminalShell: { ...state.terminalShell, [projectId]: shell },
    }));
  },

  setPreviewError: (error) => set({ previewError: error }),
  setIsMacOs: (value) => set({ isMacOs: value }),
  setIsElectron: (value) => set({ isElectron: value }),

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

    set((state) => ({
      runLogs: {
        ...state.runLogs,
        [project.id]:
          (state.runLogs[project.id] ?? "") + `\n$ ${project.runCommand}\n\n`,
      },
      previewError: null,
    }));

    await desktopApi.startRunner({
      command: project.runCommand,
      cwd: project.path,
      projectId: project.id,
      projectName: project.name,
    });
  },

  stopRunner: async () => {
    const project = get().getActiveProject();
    if (!project) return;

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    await desktopApi.stopRunner(project.id);
  },

  // ── Actions: terminal ───────────────────────────────────────────────
  startActiveTerminal: async (terminalRef) => {
    const { getActiveProject: getProject, settings } = get();
    const project = getProject();
    if (!project) return;

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    terminalRef.current?.clear();
    terminalRef.current?.focus();

    set((state) => ({
      terminalStatus: {
        ...state.terminalStatus,
        [GLOBAL_TERMINAL_SESSION_ID]: "running",
      },
    }));

    await desktopApi.startTerminal({
      cwd: project.path,
      projectId: GLOBAL_TERMINAL_SESSION_ID,
      shellPath: settings.shellPath || undefined,
    });
  },

  stopActiveTerminal: async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    set((state) => ({
      terminalStatus: {
        ...state.terminalStatus,
        [GLOBAL_TERMINAL_SESSION_ID]: "stopped",
      },
    }));

    await desktopApi.stopTerminal(GLOBAL_TERMINAL_SESSION_ID);
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
          chats: {},
          panelVisibility: DEFAULT_PANEL_VISIBILITY,
          projects: [],
          settings: DEFAULT_SETTINGS,
        };
      } else {
        try {
          loaded = mergePersistedState(
            JSON.parse(rawState) as PersistedIdeState,
          );
        } catch {
          loaded = {
            activeProjectId: null,
            chats: {},
            panelVisibility: DEFAULT_PANEL_VISIBILITY,
            projects: [],
            settings: DEFAULT_SETTINGS,
          };
        }
      }
    }

    set({
      projects: loaded.projects,
      activeProjectId: ensureActiveProject(loaded.projects, loaded.activeProjectId),
      panelVisibility: loaded.panelVisibility,
      settings: loaded.settings,
      chats: loaded.chats,
      stateHydrated: true,
    });
  },

  persist: () => {
    const { projects, activeProjectId, panelVisibility, settings, chats, stateHydrated } = get();
    if (!stateHydrated) return;

    const nextState: PersistedIdeState = {
      activeProjectId: ensureActiveProject(projects, activeProjectId),
      chats,
      panelVisibility,
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
