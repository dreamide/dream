import { create } from "zustand";
import { apiClient } from "@/lib/api-client";
import { LOCAL_HOST_ID, setHostResolver } from "@/lib/host-routing";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import {
  encodePersistedState,
  getProjectHostId,
  plainPersistedFieldsOf,
} from "../../../electron/shared/persisted-state-codec.js";
import { createFileEditorSessions } from "./file-editor-session";
import { findProjectForPath, getChatsForProject } from "./ide-state";
import { createBrowserActions } from "./store/browser-actions";
import { createCatalogActions } from "./store/catalog-actions";
import { createChatActions } from "./store/chat-actions";
import { followConnections } from "./store/connection-follow";
import { createGitWriteActions } from "./store/git-write-actions";
import {
  getBrowserTabsForProject,
  resolveActiveBrowserTab,
} from "./store/helpers";
import { createHostActions } from "./store/host-actions";
import { hostCatalogLifecycle } from "./store/host-catalog-lifecycle";
import {
  getLoadedAwaitingApprovalChatIds,
  getLoadedLocalHost,
  getLoadedRunningChatIds,
  getLoadedWorkspace,
  isHostLoaded,
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
import {
  createSettingsActions,
  settleSettings,
} from "./store/settings-actions";
import { createStashActions } from "./store/stash-actions";
import { createTerminalActions } from "./store/terminal-actions";
import { createTranscriptCache } from "./store/transcript-cache";
import * as workspace from "./store/workspace-document";
import { createWorktreeActions } from "./store/worktree-actions";

const transcriptCache = createTranscriptCache(
  () => useIdeStore.getState(),
  (state) => useIdeStore.setState(state),
);

/** Each open project's Files panel tabs and drafts (file-editor-session.ts). */
export const fileEditorSessions = createFileEditorSessions({
  api: apiClient,
  getProjectPath: (projectId) =>
    useIdeStore.getState().projects.find((project) => project.id === projectId)
      ?.path ?? null,
  onSaved: (projectId) =>
    useIdeStore.getState().bumpProjectGitRefreshKey(projectId),
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useIdeStore = create<IdeState>((set, get) => ({
  // ── Persisted state ─────────────────────────────────────────────────
  ...plainPersistedFieldsOf({}),
  projects: [],
  closedProjects: [],
  activeProjectId: null,
  savedPrompts: [],
  chats: [],
  settings: DEFAULT_SETTINGS,
  messagesByChatId: {},
  transcriptPageByChatId: {},
  pendingChatSubmitByChatId: {},

  // ── Runtime state ───────────────────────────────────────────────────
  streamingChatIds: {},
  hostRunningChatIds: {},
  hostAwaitingApprovalChatIds: {},
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
  projectGitPanelTabByProject: {},
  outputPanelOpen: false,
  browserError: null,
  browserLoading: {},
  browserTabsByProject: {},
  activeBrowserTabIdByProject: {},
  projectGitRefreshKeys: {},
  gitWriteByProject: {},
  projectFilesRefreshKeys: {},
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
  ...createGitWriteActions(set, get),
  ...createChatActions(set, get),
  ...createStashActions(set, get),
  ...createSavedPromptActions(set, get),

  // ── Actions: panels ─────────────────────────────────────────────────
  ...createPanelActions(set, get, { fileEditor: fileEditorSessions }),

  // ── Actions: settings ───────────────────────────────────────────────
  ...createSettingsActions(set, get),

  // ── Actions: runtime ────────────────────────────────────────────────
  ...createRuntimeActions(set),
  ...createBrowserActions(set),
  ...createTerminalActions(set, get),

  // ── Actions: hydration & persistence ────────────────────────────────
  hydrate: async () => {
    const loaded = await loadPersistedIdeState();
    const restored = workspace.restore(
      {
        activeProjectId: loaded.activeProjectId,
        chats: loaded.chats,
        closedProjects: loaded.closedProjects,
        messagesByChatId: loaded.messagesByChatId,
        projects: loaded.projects,
      },
      loaded.settings,
    );

    set({
      ...restored,
      // Models the loaded settings no longer offer move on load.
      ...settleSettings(restored, loaded.settings),
      ...plainPersistedFieldsOf(loaded),
      savedPrompts: loaded.savedPrompts,
      activeBrowserTabIdByProject: loaded.activeBrowserTabIdByProject,
      browserTabsByProject: loaded.browserTabsByProject,
      hostRunningChatIds: Object.fromEntries(
        getLoadedRunningChatIds().map((chatId) => [chatId, true as const]),
      ),
      hostAwaitingApprovalChatIds: Object.fromEntries(
        getLoadedAwaitingApprovalChatIds().map((chatId) => [
          chatId,
          true as const,
        ]),
      ),
      stateHydrated: true,
      persistenceBlocked: !isWorkspaceLoaded(),
    });
    transcriptCache.markHydrated(restored.messagesByChatId);
    // Saves the local host's identity as this client's `local` connection.
    // Its catalog is already in: the local host is this app's own, so it
    // is never refused, only recorded.
    // A browser client whose home host was away at startup records it
    // when its catalog comes in (store/connection-follow.ts).
    if (isHostLoaded(LOCAL_HOST_ID)) {
      try {
        hostCatalogLifecycle(set, get).accept(LOCAL_HOST_ID, {
          host: getLoadedLocalHost(),
        });
      } catch (error) {
        console.warn("Unable to record the local host's identity.", error);
      }
    }

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
followConnections(useIdeStore);

// The Files panel sessions follow the store: a files refresh reads clean
// files again, and a project that is no longer open takes its session with
// it.
useIdeStore.subscribe((state, previous) => {
  if (state.projectFilesRefreshKeys !== previous.projectFilesRefreshKeys) {
    for (const [projectId, key] of Object.entries(
      state.projectFilesRefreshKeys,
    )) {
      if (previous.projectFilesRefreshKeys[projectId] !== key) {
        fileEditorSessions.refresh(projectId);
      }
    }
  }
  if (state.projects !== previous.projects) {
    const openIds = new Set(state.projects.map((project) => project.id));
    for (const project of previous.projects) {
      if (!openIds.has(project.id)) fileEditorSessions.drop(project.id);
    }
  }
});

/**
 * Saves the dirty slices (store/save-scheduler.ts): what changed in the
 * workspace to the main process, and, when projects or chats changed, what
 * changed in each host's catalog. Only a project or chat change needs the
 * chats encoded.
 */
const saveSlices = (dirty: ReadonlySet<SaveSlice>) => {
  const state = useIdeStore.getState();
  const {
    activeProjectId,
    activeBrowserTabIdByProject,
    browserTabsByProject,
    chats,
    closedProjects,
    savedPrompts,
    projects,
    settings,
    stateHydrated,
  } = state;
  if (!stateHydrated) return;

  const catalogChanged = dirty.has("projects") || dirty.has("chats");
  const encoded = encodePersistedState({
    ...plainPersistedFieldsOf(state),
    activeBrowserTabIdByProject,
    activeProjectId,
    savedPrompts,
    browserTabsByProject,
    // Config and saved prompts do not depend on chats.
    chats: catalogChanged ? chats : [],
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
    const match = findProjectForPath(
      projects,
      state.activeProjectId,
      hint.projectPath,
    );
    if (match) return getProjectHostId(match);
  }
  return LOCAL_HOST_ID;
});
