import type { UIMessage } from "ai";
import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { ensureActiveProject, getChatsForProject } from "./ide-state";
import { getBrowserTabsForProject, resolveActiveBrowserTab } from "./store";
import { createBrowserActions } from "./store/browser-actions";
import {
  createPersistedIdeState,
  loadPersistedChatMessages,
  loadPersistedIdeState,
  savePersistedChatMessages,
  savePersistedIdeState,
} from "./store/ide-store-persistence";
import type { IdeState } from "./store/ide-store-types";
import { createPanelActions } from "./store/panel-actions";
import { createProjectActions } from "./store/project-actions";
import { DEFAULT_PROVIDER_MODELS } from "./store/provider-model-state";
import { createRuntimeActions } from "./store/runtime-actions";
import { createSettingsActions } from "./store/settings-actions";
import { createTerminalActions } from "./store/terminal-actions";

const chatMessageLoadPromises = new Map<string, Promise<UIMessage[]>>();

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
      activeBrowserTabIdByProject: loaded.activeBrowserTabIdByProject,
      browserTabsByProject: loaded.browserTabsByProject,
      chats: loaded.chats,
      messagesByChatId: loaded.messagesByChatId,
      draftChatIdByProject,
      settings: loaded.settings,
      chatSort: loaded.chatSort,
      stateHydrated: true,
    });
  },

  loadMessagesForChat: async (chatId) => {
    const existing = get().messagesByChatId[chatId];
    if (existing) {
      return existing;
    }

    const inFlight = chatMessageLoadPromises.get(chatId);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = loadPersistedChatMessages(chatId)
      .then((messages) => {
        set((state) => {
          const currentMessages = state.messagesByChatId[chatId];
          const resolvedMessages = currentMessages ?? messages;
          return {
            chats: state.chats.map((chat) =>
              chat.id === chatId
                ? { ...chat, messageCount: resolvedMessages.length }
                : chat,
            ),
            messagesByChatId: {
              ...state.messagesByChatId,
              [chatId]: resolvedMessages,
            },
          };
        });
        return get().messagesByChatId[chatId] ?? messages;
      })
      .finally(() => {
        chatMessageLoadPromises.delete(chatId);
      });

    chatMessageLoadPromises.set(chatId, loadPromise);
    return loadPromise;
  },

  persistMessagesForChat: async (chatId, messages) => {
    if (messages) {
      get().setMessagesForChat(chatId, messages);
    }

    const persistedMessages = get().messagesByChatId[chatId];
    if (!persistedMessages) {
      return;
    }

    try {
      // Queue metadata first so a newly created chat satisfies the message
      // table's foreign key before its transcript write runs.
      get().persist();
      await savePersistedChatMessages(chatId, persistedMessages);
    } catch (error) {
      console.warn(`Unable to persist messages for chat ${chatId}.`, error);
    }
  },

  persist: () => {
    const {
      activeProjectId,
      activeBrowserTabIdByProject,
      browserTabsByProject,
      chatSort,
      chats,
      closedProjects,
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
      // Message bodies have their own per-chat persistence path. Keeping them
      // out of metadata saves avoids cloning every loaded transcript for IPC.
      messagesByChatId: {},
      projects,
      settings,
    });

    savePersistedIdeState(nextState);
  },
}));
