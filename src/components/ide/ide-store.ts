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
import { readCachedProviderModels } from "./store/provider-model-cache";
import { createRuntimeActions } from "./store/runtime-actions";
import { createSettingsActions } from "./store/settings-actions";
import { createTerminalActions } from "./store/terminal-actions";
import { createTranscriptCache } from "./store/transcript-cache";

const transcriptCache = createTranscriptCache(
  () => useIdeStore.getState(),
  (state) => useIdeStore.setState(state),
);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  projects: [],
  closedProjects: [],
  activeProjectId: null,
  appView: "code",
  tasks: [],
  chats: [],
  chatSort: "recent",
  settings: DEFAULT_SETTINGS,
  messagesByChatId: {},
  pendingChatSubmitByChatId: {},

  // ── Runtime state ───────────────────────────────────────────────────
  streamingChatIds: {},
  awaitingAnswerChatIds: {},
  completedChatIds: {},
  titleGeneratingChatIds: {},
  draftChatIdByProject: {},
  terminalStatus: {},
  terminalTransport: {},
  terminalShell: {},
  terminalSessionNames: {},
  nextTerminalOrdinalByProject: {},
  projectTerminalSessionIds: {},
  activeTerminalSessionIdByProject: {},
  projectTerminalPanelOpenByProject: {},
  outputPanelOpen: false,
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
  // Seeded from the last session so pickers are complete before the first
  // fetch returns; `refreshProviderModels` still runs on startup.
  providerModels: readCachedProviderModels(),

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
  ...createPanelActions(set),

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

    // Re-register each project's active empty chat as its draft so a
    // restored fresh chat is reused instead of a new one being created.
    const draftChatIdByProject: Record<string, string | null> = {};
    for (const project of [...loaded.projects, ...loaded.closedProjects]) {
      const activeChatId = project.ui.activeChatId;
      if (
        activeChatId &&
        (loaded.chats.find((chat) => chat.id === activeChatId)?.messageCount ??
          0) === 0 &&
        loaded.chats.some(
          (chat) => chat.id === activeChatId && chat.deletedAt === null,
        )
      ) {
        draftChatIdByProject[project.id] = activeChatId;
      }
    }

    set({
      projects: loaded.projects,
      closedProjects: loaded.closedProjects,
      activeProjectId: nextActiveProjectId,
      appView: loaded.appView,
      tasks: loaded.tasks,
      activeBrowserTabIdByProject: loaded.activeBrowserTabIdByProject,
      browserTabsByProject: loaded.browserTabsByProject,
      chats: loaded.chats,
      messagesByChatId: loaded.messagesByChatId,
      draftChatIdByProject,
      settings: loaded.settings,
      chatSort: loaded.chatSort,
      stateHydrated: true,
    });
    transcriptCache.markHydrated(loaded.messagesByChatId);
  },

  ...transcriptCache.actions,

  persist: () => {
    const {
      activeProjectId,
      activeBrowserTabIdByProject,
      appView,
      browserTabsByProject,
      chatSort,
      chats,
      closedProjects,
      tasks,
      projects,
      settings,
      stateHydrated,
    } = get();
    if (!stateHydrated) return;

    const nextState = createPersistedIdeState({
      activeBrowserTabIdByProject,
      activeProjectId,
      appView,
      tasks,
      browserTabsByProject,
      chats,
      chatSort,
      closedProjects,
      // Message bodies have their own per-chat persistence path. Keeping them
      // out of metadata saves avoids cloning every loaded transcript for IPC.
      messagesByChatId: {},
      projects,
      settings,
    });

    savePersistedIdeState(nextState);
  },
}));

useIdeStore.subscribe(transcriptCache.observe);
