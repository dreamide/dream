import { create } from "zustand";
import { LOCAL_HOST_ID, setHostResolver } from "@/lib/host-routing";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import {
  encodePersistedState,
  ensureActiveProject,
  getProjectHostId,
  normalizeProjectPathKey,
} from "../../../electron/shared/persisted-state-codec.js";
import { getChatsForProject } from "./ide-state";
import { createBrowserActions } from "./store/browser-actions";
import { createCatalogActions } from "./store/catalog-actions";
import { createChatActions } from "./store/chat-actions";
import {
  getBrowserTabsForProject,
  resolveActiveBrowserTab,
} from "./store/helpers";
import { createHostActions } from "./store/host-actions";
import {
  getLoadedRunningChatIds,
  getLoadedWorkspace,
  isWorkspaceLoaded,
  loadPersistedIdeState,
  pushPersistedCatalogs,
  savePersistedWorkspace,
  setCatalogConflictHandler,
} from "./store/ide-store-persistence";
import type { IdeState } from "./store/ide-store-types";
import { createPanelActions } from "./store/panel-actions";
import { createProjectLifecycleActions } from "./store/project-lifecycle-actions";
import { readCachedProviderModels } from "./store/provider-model-cache";
import { createRuntimeActions } from "./store/runtime-actions";
import {
  browserSaveTimers,
  createSaveScheduler,
  type SaveSlice,
} from "./store/save-scheduler";
import { createSavedPromptActions } from "./store/saved-prompt-actions";
import { createSettingsActions } from "./store/settings-actions";
import { createStashActions } from "./store/stash-actions";
import { createTerminalActions } from "./store/terminal-actions";
import { createTranscriptCache } from "./store/transcript-cache";
import { createWorktreeActions } from "./store/worktree-actions";

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
  savedPrompts: [],
  chats: [],
  chatSort: "recent",
  settings: DEFAULT_SETTINGS,
  messagesByChatId: {},
  pendingChatSubmitByChatId: {},

  // ── Runtime state ───────────────────────────────────────────────────
  streamingChatIds: {},
  hostRunningChatIds: {},
  hosts: {},
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
  projectGitLogPanelOpenByProject: {},
  outputPanelOpen: false,
  browserError: null,
  browserLoading: {},
  browserTabsByProject: {},
  activeBrowserTabIdByProject: {},
  projectGitRefreshKeys: {},
  projectFilesRefreshKeys: {},
  projectFileOpenRequests: {},
  projectFileSearchRequests: {},
  stateHydrated: false,
  persistenceBlocked: false,
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
  cliLatestVersions: {},
  cliUpgrades: {},

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

  // ── Actions: projects and chats ─────────────────────────────────────
  ...createProjectLifecycleActions(set, get),
  ...createWorktreeActions(set, get),
  ...createChatActions(set, get),
  ...createStashActions(set, get),
  ...createSavedPromptActions(set, get),

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
      savedPrompts: loaded.savedPrompts,
      activeBrowserTabIdByProject: loaded.activeBrowserTabIdByProject,
      browserTabsByProject: loaded.browserTabsByProject,
      chats: loaded.chats,
      messagesByChatId: loaded.messagesByChatId,
      draftChatIdByProject,
      settings: loaded.settings,
      chatSort: loaded.chatSort,
      hostRunningChatIds: Object.fromEntries(
        getLoadedRunningChatIds().map((chatId) => [chatId, true as const]),
      ),
      stateHydrated: true,
      persistenceBlocked: !isWorkspaceLoaded(),
    });
    transcriptCache.markHydrated(loaded.messagesByChatId);

    void get().resumeHosts(
      getLoadedWorkspace()
        .workspaceProjects.filter(
          (entry) => entry.status === "open" && entry.hostId !== LOCAL_HOST_ID,
        )
        .map((entry) => entry.hostId),
    );
  },

  ...transcriptCache.actions,
  ...createCatalogActions(set, get),
  ...createHostActions(set, get),

  // Saves now, every slice; see the save scheduler below.
  persist: () => saveScheduler.saveAll(),
}));

useIdeStore.subscribe(transcriptCache.observe);

/**
 * Saves the dirty slices (store/save-scheduler.ts): what changed in the
 * workspace to the main process, and, when projects or chats changed, what
 * changed in each host's catalog. Only a project or chat change needs the
 * chats encoded.
 */
const saveSlices = (dirty: ReadonlySet<SaveSlice>) => {
  const {
    activeProjectId,
    activeBrowserTabIdByProject,
    appView,
    browserTabsByProject,
    chatSort,
    chats,
    closedProjects,
    savedPrompts,
    projects,
    settings,
    stateHydrated,
  } = useIdeStore.getState();
  if (!stateHydrated) return;

  const catalogChanged = dirty.has("projects") || dirty.has("chats");
  const encoded = encodePersistedState({
    activeBrowserTabIdByProject,
    activeProjectId,
    appView,
    savedPrompts,
    browserTabsByProject,
    // Config and saved prompts do not depend on chats.
    chats: catalogChanged ? chats : [],
    chatSort,
    closedProjects,
    // Message bodies have their own per-chat persistence path.
    messagesByChatId: {},
    projects,
    settings,
  });

  savePersistedWorkspace(encoded, { rows: catalogChanged });
  if (catalogChanged) {
    pushPersistedCatalogs(encoded, { chats, closedProjects, projects });
  }
};

const saveScheduler = createSaveScheduler({
  save: saveSlices,
  timers: browserSaveTimers(),
});
useIdeStore.subscribe(saveScheduler.observe);
if (typeof window !== "undefined") {
  // Reload tears the document down without waiting for a scheduled save.
  window.addEventListener("beforeunload", saveScheduler.flush);
  window.addEventListener("pagehide", saveScheduler.flush);
}

// Which host a request is for (host-routing.ts): the host of the project the
// request names, by id, by one of its chats or terminals, or by path.
const TERMINAL_SESSION_PROJECT = /^__(?:project|browser)_terminal__:([^:]+)/;
// A project a host refused (it already has one at that path) becomes the
// host's project.
setCatalogConflictHandler((hostId, conflicts) => {
  void useIdeStore.getState().adoptHostProjects(hostId, conflicts);
});

setHostResolver((hint) => {
  const state = useIdeStore.getState();
  const projects = [...state.projects, ...state.closedProjects];
  const hostOf = (projectId: unknown) => {
    const project =
      typeof projectId === "string"
        ? projects.find((item) => item.id === projectId)
        : undefined;
    return project ? getProjectHostId(project) : null;
  };

  const byProject = hostOf(hint.projectId);
  if (byProject) return byProject;
  if (typeof hint.chatId === "string") {
    const chat = state.chats.find((item) => item.id === hint.chatId);
    const byChat = hostOf(chat?.projectId);
    if (byChat) return byChat;
  }
  if (typeof hint.sessionId === "string") {
    const bySession = hostOf(
      TERMINAL_SESSION_PROJECT.exec(hint.sessionId)?.[1],
    );
    if (bySession) return bySession;
  }
  if (typeof hint.projectPath === "string") {
    // The same path can exist on two hosts: the active project's first.
    const key = normalizeProjectPathKey(hint.projectPath);
    const matches = projects.filter(
      (project) => normalizeProjectPathKey(project.path) === key,
    );
    const active = matches.find(
      (project) => project.id === state.activeProjectId,
    );
    const match = active ?? matches[0];
    if (match) return getProjectHostId(match);
  }
  return LOCAL_HOST_ID;
});
