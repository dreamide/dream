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

/** The browser tab actions in the store (`IdeState`). */
export interface BrowserActions {
  setBrowserError: (error: string | null) => void;
  setBrowserLoading: (id: string, loading: boolean) => void;
  ensureBrowserTabs: (projectId: string, initialUrl?: string) => void;
  createBrowserTab: (projectId: string, initialUrl?: string) => string | null;
  updateBrowserTab: (
    projectId: string,
    tabId: string,
    updater: (tab: BrowserTabState) => BrowserTabState,
  ) => void;
  closeBrowserTab: (projectId: string, tabId: string) => string | null;
  reorderBrowserTabs: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  setActiveBrowserTab: (projectId: string, tabId: string | null) => void;
}

/** Tab transitions settle selection, the saved URL and removed loading state together. */
export const createBrowserActions = (set: IdeStoreSet): BrowserActions => {
  const changeTabs = (
    projectId: string,
    update: (current: Tabs) => Tabs,
  ): string | null => {
    const id = projectId.trim();
    let activeId: string | null = null;
    if (!id) return activeId;
    set((state) => {
      const project = state.projects.find((item) => item.id === id);
      // A late webview event cannot recreate a closed project's runtime state.
      if (!project) return state;
      const tabs = state.browserTabsByProject[id] ?? [];
      const activeTabId = state.activeBrowserTabIdByProject[id] ?? null;
      const next = update({ tabs, activeTabId });
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
      const browserLoading = removed.length
        ? { ...state.browserLoading }
        : state.browserLoading;
      for (const tab of removed) delete browserLoading[tab.id];
      return {
        browserLoading,
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
    return activeId;
  };

  return {
    setBrowserError: (error) => set({ browserError: error }),

    setBrowserLoading: (id, loading) => {
      set((state) => {
        if (
          !state.projects.some((project) =>
            state.browserTabsByProject[project.id]?.some(
              (tab) => tab.id === id,
            ),
          )
        )
          return state;
        return { browserLoading: { ...state.browserLoading, [id]: loading } };
      });
    },

    ensureBrowserTabs: (projectId, initialUrl = "") => {
      changeTabs(projectId, (current) => {
        if (current.tabs.length) return current;
        const tab = createBrowserTabState(initialUrl);
        return { tabs: [tab], activeTabId: tab.id };
      });
    },

    createBrowserTab: (projectId, initialUrl = "") =>
      changeTabs(projectId, ({ tabs }) => {
        const tab = createBrowserTabState(initialUrl);
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),

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
      }),

    reorderBrowserTabs: (projectId, fromIndex, toIndex) => {
      changeTabs(projectId, (current) => ({
        ...current,
        tabs: moveItem(current.tabs, fromIndex, toIndex),
      }));
    },

    setActiveBrowserTab: (projectId, tabId) => {
      changeTabs(projectId, (current) => ({ ...current, activeTabId: tabId }));
    },
  };
};
