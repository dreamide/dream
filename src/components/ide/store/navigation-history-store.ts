import { create } from "zustand";
import { useIdeStore } from "../ide-store";
import type { IdeState } from "./ide-store-types";
import {
  EMPTY_NAV_HISTORY,
  type NavHistory,
  type NavLocation,
  pruneNavHistory,
  recordNavLocation,
  replaceCurrentNavLocation,
  stepNavHistory,
} from "./navigation-history";

/**
 * Back/forward history for the header arrows. Runtime only: like a browser,
 * history starts empty on every launch and is never persisted.
 */
export const useNavigationHistoryStore = create<{ history: NavHistory }>(
  () => ({ history: EMPTY_NAV_HISTORY }),
);

const getCurrentNavLocation = (
  state: Pick<IdeState, "activeProjectId" | "projects">,
): NavLocation | null => {
  const project = state.projects.find(
    (item) => item.id === state.activeProjectId,
  );
  if (!project) {
    return null;
  }

  return { chatId: project.ui.activeChatId ?? null, projectId: project.id };
};

/** Whether a location still exists: its project is open and its chat is live. */
const createNavLocationValidator = (
  state: Pick<IdeState, "chats" | "projects">,
) => {
  const openProjectIds = new Set(state.projects.map((project) => project.id));
  const liveChatProjectIds = new Map<string, string>();
  for (const chat of state.chats) {
    if (chat.deletedAt === null) {
      liveChatProjectIds.set(chat.id, chat.projectId);
    }
  }

  return (location: NavLocation) =>
    openProjectIds.has(location.projectId) &&
    (location.chatId === null ||
      liveChatProjectIds.get(location.chatId) === location.projectId);
};

const setHistory = (history: NavHistory) => {
  if (history !== useNavigationHistoryStore.getState().history) {
    useNavigationHistoryStore.setState({ history });
  }
};

// Set while back/forward is switching project and chat, so the switch is not
// recorded as a new visit.
let traversing = false;

/**
 * Watches the IDE store and records every change of project or focused chat,
 * wherever it came from (a tab click, opening a project, a new chat, ...).
 * Returns the unsubscribe function.
 */
export const startNavigationHistoryTracking = () => {
  let lastActiveProjectId: string | null | undefined;
  let lastProjects: IdeState["projects"] | undefined;
  let lastChats: IdeState["chats"] | undefined;

  const observe = (state: IdeState) => {
    if (!state.stateHydrated) {
      return;
    }

    // The store changes constantly while chats stream; only location-related
    // changes matter here.
    if (
      state.activeProjectId === lastActiveProjectId &&
      state.projects === lastProjects &&
      state.chats === lastChats
    ) {
      return;
    }
    lastActiveProjectId = state.activeProjectId;
    lastProjects = state.projects;
    lastChats = state.chats;

    let history = useNavigationHistoryStore.getState().history;
    const location = getCurrentNavLocation(state);
    if (location && !traversing) {
      history = recordNavLocation(history, location);
    }
    setHistory(pruneNavHistory(history, createNavLocationValidator(state)));
  };

  observe(useIdeStore.getState());
  return useIdeStore.subscribe(observe);
};

/** Goes one step back (-1) or forward (1). Does nothing at either end. */
export const navigateHistory = (direction: -1 | 1) => {
  const ide = useIdeStore.getState();
  const current = pruneNavHistory(
    useNavigationHistoryStore.getState().history,
    createNavLocationValidator(ide),
  );
  const next = stepNavHistory(current, direction);
  if (!next) {
    setHistory(current);
    return;
  }

  const target = next.entries[next.index];
  setHistory(next);

  traversing = true;
  try {
    // Focus the chat first so the project opens straight onto it.
    if (target.chatId) {
      ide.setActiveChatId(target.projectId, target.chatId);
    }
    ide.setActiveProjectId(target.projectId);
    // Settings covers the workspace; going back or forward means leaving it.
    if (ide.settingsOpen) {
      ide.setSettingsOpen(false);
    }
  } finally {
    traversing = false;
  }

  const landed = getCurrentNavLocation(useIdeStore.getState());
  if (landed) {
    setHistory(
      replaceCurrentNavLocation(
        useNavigationHistoryStore.getState().history,
        landed,
      ),
    );
  }
};
