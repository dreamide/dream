import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { ensureActiveProject, getChatsForProject } from "./ide-state";
import { getBrowserTabsForProject, resolveActiveBrowserTab } from "./store";
import { createBrowserActions } from "./store/browser-actions";
import {
  createPersistedIdeState,
  loadPersistedIdeState,
  savePersistedIdeState,
} from "./store/ide-store-persistence";
import type { IdeState } from "./store/ide-store-types";
import { createPanelActions } from "./store/panel-actions";
import { createProjectActions } from "./store/project-actions";
import {
  DEFAULT_PROVIDER_MODELS,
  getPermissionModesForAutoAccept,
} from "./store/provider-model-state";
import { createRuntimeActions } from "./store/runtime-actions";
import { createSettingsActions } from "./store/settings-actions";
import { createTerminalActions } from "./store/terminal-actions";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  projects: [],
  closedProjects: [],
  activeProjectId: null,
  chats: [],
  chatSort: "recent",
  settings: DEFAULT_SETTINGS,
  messagesByChatId: {},

  // ── Runtime state ───────────────────────────────────────────────────
  streamingChatIds: {},
  titleGeneratingChatIds: {},
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
  projectFilesRefreshKeys: {},
  projectFileOpenRequests: {},
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
    const { getActiveProject, chats } = get();
    const project = getActiveProject();
    if (!project) {
      return null;
    }

    const activeChatId = project.ui.activeChatId;
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
  ...createProjectActions(set, get),

  // ── Actions: panels ─────────────────────────────────────────────────
  ...createPanelActions(set, get),

  // ── Actions: settings ───────────────────────────────────────────────
  ...createSettingsActions(set, get),

  // ── Actions: runtime ────────────────────────────────────────────────
  ...createRuntimeActions(set),
  ...createBrowserActions(set, get),
  ...createTerminalActions(set, get),

  // ── Actions: hydration & persistence ────────────────────────────────
  hydrate: async () => {
    const loaded = await loadPersistedIdeState();
    const nextActiveProjectId = ensureActiveProject(
      loaded.projects,
      loaded.activeProjectId,
    );

    set({
      projects: loaded.projects,
      closedProjects: loaded.closedProjects,
      activeProjectId: nextActiveProjectId,
      activeBrowserTabIdByProject: loaded.activeBrowserTabIdByProject,
      browserTabsByProject: loaded.browserTabsByProject,
      chats: loaded.chats,
      messagesByChatId: loaded.messagesByChatId,
      draftChatIdByProject: {},
      settings: loaded.settings,
      chatSort: loaded.chatSort,
      ...getPermissionModesForAutoAccept(loaded.settings.autoAcceptPermissions),
      stateHydrated: true,
    });
  },

  persist: () => {
    const {
      activeProjectId,
      activeBrowserTabIdByProject,
      browserTabsByProject,
      chatSort,
      chats,
      closedProjects,
      draftChatIdByProject,
      messagesByChatId,
      projects,
      settings,
      stateHydrated,
    } = get();
    if (!stateHydrated) return;

    const nextState = createPersistedIdeState({
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
    });

    savePersistedIdeState(nextState);
  },
}));
