import type { BrowserTabState } from "@/types/ide";
import {
  createBrowserTabState,
  moveItem,
  resolveActiveBrowserTab,
} from "./helpers";
import type { IdeStoreSet } from "./ide-store-types";

interface Tabs {
  tabs: BrowserTabState[];
  activeTabId: string | null;
}

export interface BrowserTabStatus {
  loading: boolean;
  error: string | null;
}

/** The browser tab actions in the store (`IdeState`). */
export interface BrowserActions {
  updateBrowserTabStatus: (
    projectId: string,
    tabId: string,
    update: Partial<BrowserTabStatus>,
  ) => void;
  ensureBrowserTabs: (projectId: string, initialUrl?: string) => void;
  /**
   * Add a tab and return its id. It becomes the active tab unless
   * `activate` is false (an agent opening a tab in the background).
   */
  createBrowserTab: (
    projectId: string,
    initialUrl?: string,
    options?: { activate?: boolean },
  ) => string | null;
  updateBrowserTab: (
    projectId: string,
    tabId: string,
    updater: (tab: BrowserTabState) => BrowserTabState,
  ) => void;
  navigateBrowserTab: (
    projectId: string,
    tabId: string,
    url: string,
    title?: string,
  ) => void;
  closeBrowserTab: (projectId: string, tabId: string) => string | null;
  reorderBrowserTabs: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  setActiveBrowserTab: (projectId: string, tabId: string | null) => void;
  /**
   * Keep a tab's webview mounted for agent tools and make it the agent's
   * most recent tab (last in `agentBrowserTabIdsByProject`).
   */
  holdAgentBrowserTab: (projectId: string, tabId: string) => void;
}

/** Tab transitions settle selection, the saved URL and removed loading state together. */
export const createBrowserActions = (set: IdeStoreSet): BrowserActions => {
  const changeTabs = (
    projectId: string,
    update: (current: Tabs) => Tabs,
    navigatingTabId?: string,
  ): { activeId: string | null; createdId: string | null } => {
    const id = projectId.trim();
    let activeId: string | null = null;
    let createdId: string | null = null;
    if (!id) return { activeId, createdId };
    set((state) => {
      const project = state.projects.find((item) => item.id === id);
      // A late webview event cannot recreate a closed project's runtime state.
      if (!project) return state;
      const tabs = state.browserTabsByProject[id] ?? [];
      if (navigatingTabId && !tabs.some((tab) => tab.id === navigatingTabId))
        return state;
      const activeTabId = state.activeBrowserTabIdByProject[id] ?? null;
      const next = update({ tabs, activeTabId });
      createdId =
        next.tabs.find((tab) => !tabs.some((item) => item.id === tab.id))?.id ??
        null;
      if (!next.tabs.length && next.tabs === tabs) return state;
      const active = resolveActiveBrowserTab(next.tabs, next.activeTabId);
      activeId = active?.id ?? null;
      const url = active?.url ?? "";
      if (
        next.tabs === tabs &&
        activeId === activeTabId &&
        project.browserUrl === url
      )
        return state;
      const removed = tabs.filter(
        (tab) => !next.tabs.some((item) => item.id === tab.id),
      );
      const navigation = navigatingTabId
        ? state.browserStatusByTab[navigatingTabId]
        : undefined;
      const browserStatusByTab =
        removed.length || navigation?.error
          ? { ...state.browserStatusByTab }
          : state.browserStatusByTab;
      for (const tab of removed) delete browserStatusByTab[tab.id];
      if (navigation?.error && navigatingTabId) {
        browserStatusByTab[navigatingTabId] = { ...navigation, error: null };
      }
      const held = state.agentBrowserTabIdsByProject[id];
      const keptHeld = held?.filter(
        (tabId) => !removed.some((tab) => tab.id === tabId),
      );
      return {
        agentBrowserTabIdsByProject:
          held && keptHeld && keptHeld.length !== held.length
            ? { ...state.agentBrowserTabIdsByProject, [id]: keptHeld }
            : state.agentBrowserTabIdsByProject,
        browserStatusByTab,
        browserTabsByProject:
          next.tabs === tabs
            ? state.browserTabsByProject
            : { ...state.browserTabsByProject, [id]: next.tabs },
        activeBrowserTabIdByProject:
          activeId === activeTabId
            ? state.activeBrowserTabIdByProject
            : { ...state.activeBrowserTabIdByProject, [id]: activeId },
        projects:
          project.browserUrl === url
            ? state.projects
            : state.projects.map((item) =>
                item.id === id ? { ...item, browserUrl: url } : item,
              ),
      };
    });
    return { activeId, createdId };
  };

  return {
    updateBrowserTabStatus: (projectId, tabId, update) => {
      set((state) => {
        if (
          !state.projects.some((project) => project.id === projectId) ||
          !state.browserTabsByProject[projectId]?.some(
            (tab) => tab.id === tabId,
          )
        )
          return state;
        const previous = state.browserStatusByTab[tabId];
        const status = {
          loading: update.loading ?? previous?.loading ?? false,
          error: update.loading ? null : (previous?.error ?? null),
          ...update,
        };
        if (
          status.loading === (previous?.loading ?? false) &&
          status.error === (previous?.error ?? null)
        )
          return state;
        return {
          browserStatusByTab: { ...state.browserStatusByTab, [tabId]: status },
        };
      });
    },

    ensureBrowserTabs: (projectId, initialUrl = "") => {
      changeTabs(projectId, (current) => {
        if (current.tabs.length) return current;
        const tab = createBrowserTabState(initialUrl);
        return { tabs: [tab], activeTabId: tab.id };
      });
    },

    createBrowserTab: (projectId, initialUrl = "", options = {}) => {
      const { activeId, createdId } = changeTabs(
        projectId,
        ({ tabs, activeTabId }) => {
          const tab = createBrowserTabState(initialUrl);
          return {
            tabs: [...tabs, tab],
            activeTabId:
              options.activate === false && activeTabId ? activeTabId : tab.id,
          };
        },
      );
      return options.activate === false ? createdId : activeId;
    },

    navigateBrowserTab: (projectId, tabId, url, title) => {
      changeTabs(
        projectId,
        (current) => ({
          ...current,
          tabs: current.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, url, title: title ?? tab.title } : tab,
          ),
        }),
        tabId,
      );
    },

    updateBrowserTab: (projectId, tabId, updater) => {
      changeTabs(projectId, (current) => {
        let changed = false;
        const tabs = current.tabs.map((tab) => {
          if (tab.id !== tabId.trim()) return tab;
          const next = updater(tab);
          changed ||= next !== tab;
          return next;
        });
        return changed ? { ...current, tabs } : current;
      });
    },

    closeBrowserTab: (projectId, tabId) =>
      changeTabs(projectId, (current) => {
        const index = current.tabs.findIndex((tab) => tab.id === tabId.trim());
        if (index < 0) return current;
        const tabs = current.tabs.filter((_, tabIndex) => tabIndex !== index);
        if (!tabs.length) {
          const tab = createBrowserTabState();
          return { tabs: [tab], activeTabId: tab.id };
        }
        return {
          tabs,
          activeTabId:
            current.activeTabId === tabId.trim()
              ? tabs[Math.min(index, tabs.length - 1)].id
              : current.activeTabId,
        };
      }).activeId,

    reorderBrowserTabs: (projectId, fromIndex, toIndex) => {
      changeTabs(projectId, (current) => ({
        ...current,
        tabs: moveItem(current.tabs, fromIndex, toIndex),
      }));
    },

    setActiveBrowserTab: (projectId, tabId) => {
      changeTabs(projectId, (current) => ({ ...current, activeTabId: tabId }));
    },

    holdAgentBrowserTab: (projectId, tabId) => {
      set((state) => {
        const held = state.agentBrowserTabIdsByProject[projectId] ?? [];
        if (
          held.at(-1) === tabId ||
          !state.browserTabsByProject[projectId]?.some(
            (tab) => tab.id === tabId,
          )
        )
          return state;
        return {
          agentBrowserTabIdsByProject: {
            ...state.agentBrowserTabIdsByProject,
            [projectId]: [...held.filter((id) => id !== tabId), tabId],
          },
        };
      });
    },
  };
};
