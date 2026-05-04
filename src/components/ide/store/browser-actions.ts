import {
  createBrowserTabState,
  moveItem,
  resolveActiveBrowserTab,
} from "./helpers";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

export const createBrowserActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "setBrowserError"
  | "setBrowserLoading"
  | "ensureBrowserTabs"
  | "createBrowserTab"
  | "updateBrowserTab"
  | "closeBrowserTab"
  | "reorderBrowserTabs"
  | "setActiveBrowserTab"
> => ({
  setBrowserError: (error) => set({ browserError: error }),

  setBrowserLoading: (id, loading) => {
    set((state) => ({
      browserLoading: { ...state.browserLoading, [id]: loading },
    }));
  },

  ensureBrowserTabs: (projectId, initialUrl = "") => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const existingTabs =
        state.browserTabsByProject[normalizedProjectId] ?? [];
      if (existingTabs.length > 0) {
        const activeTabId =
          state.activeBrowserTabIdByProject[normalizedProjectId] ?? null;
        if (activeTabId && existingTabs.some((tab) => tab.id === activeTabId)) {
          return state;
        }

        return {
          activeBrowserTabIdByProject: {
            ...state.activeBrowserTabIdByProject,
            [normalizedProjectId]: existingTabs[0]?.id ?? null,
          },
        };
      }

      const initialTab = createBrowserTabState(initialUrl);
      return {
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: [initialTab],
        },
        activeBrowserTabIdByProject: {
          ...state.activeBrowserTabIdByProject,
          [normalizedProjectId]: initialTab.id,
        },
      };
    });
  },

  createBrowserTab: (projectId, initialUrl = "") => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return null;
    }

    const nextTab = createBrowserTabState(initialUrl);
    set((state) => ({
      browserTabsByProject: {
        ...state.browserTabsByProject,
        [normalizedProjectId]: [
          ...(state.browserTabsByProject[normalizedProjectId] ?? []),
          nextTab,
        ],
      },
      activeBrowserTabIdByProject: {
        ...state.activeBrowserTabIdByProject,
        [normalizedProjectId]: nextTab.id,
      },
    }));

    return nextTab.id;
  },

  updateBrowserTab: (projectId, tabId, updater) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedProjectId || !normalizedTabId) {
      return;
    }

    set((state) => {
      const tabs = state.browserTabsByProject[normalizedProjectId] ?? [];
      let changed = false;
      const nextTabs = tabs.map((tab) => {
        if (tab.id !== normalizedTabId) {
          return tab;
        }

        const updatedTab = updater(tab);
        changed = changed || updatedTab !== tab;
        return updatedTab;
      });

      if (!changed) {
        return state;
      }

      return {
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: nextTabs,
        },
      };
    });
  },

  closeBrowserTab: (projectId, tabId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedProjectId || !normalizedTabId) {
      return null;
    }

    const existingTabs = get().browserTabsByProject[normalizedProjectId] ?? [];
    const closingIndex = existingTabs.findIndex(
      (tab) => tab.id === normalizedTabId,
    );
    if (closingIndex === -1) {
      return (
        resolveActiveBrowserTab(
          existingTabs,
          get().activeBrowserTabIdByProject[normalizedProjectId],
        )?.id ?? null
      );
    }

    if (existingTabs.length <= 1) {
      const replacementTab = createBrowserTabState();
      set((state) => {
        const nextBrowserLoading = { ...state.browserLoading };
        delete nextBrowserLoading[normalizedTabId];

        return {
          browserLoading: nextBrowserLoading,
          browserTabsByProject: {
            ...state.browserTabsByProject,
            [normalizedProjectId]: [replacementTab],
          },
          activeBrowserTabIdByProject: {
            ...state.activeBrowserTabIdByProject,
            [normalizedProjectId]: replacementTab.id,
          },
        };
      });

      return replacementTab.id;
    }

    const remainingTabs = existingTabs.filter(
      (tab) => tab.id !== normalizedTabId,
    );
    const currentActiveTabId =
      get().activeBrowserTabIdByProject[normalizedProjectId] ?? null;
    const nextActiveTab =
      currentActiveTabId === normalizedTabId
        ? (remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ??
          null)
        : resolveActiveBrowserTab(remainingTabs, currentActiveTabId);
    const nextActiveTabId = nextActiveTab?.id ?? null;

    set((state) => {
      const nextBrowserLoading = { ...state.browserLoading };
      delete nextBrowserLoading[normalizedTabId];

      return {
        browserLoading: nextBrowserLoading,
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: remainingTabs,
        },
        activeBrowserTabIdByProject: {
          ...state.activeBrowserTabIdByProject,
          [normalizedProjectId]: nextActiveTabId,
        },
      };
    });

    return nextActiveTabId;
  },

  reorderBrowserTabs: (projectId, fromIndex, toIndex) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const tabs = state.browserTabsByProject[normalizedProjectId] ?? [];
      const nextTabs = moveItem(tabs, fromIndex, toIndex);
      if (nextTabs === tabs) {
        return state;
      }

      return {
        browserTabsByProject: {
          ...state.browserTabsByProject,
          [normalizedProjectId]: nextTabs,
        },
      };
    });
  },

  setActiveBrowserTab: (projectId, tabId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => {
      const tabs = state.browserTabsByProject[normalizedProjectId] ?? [];
      const nextActiveTabId =
        tabId && tabs.some((tab) => tab.id === tabId)
          ? tabId
          : (tabs[0]?.id ?? null);

      return {
        activeBrowserTabIdByProject: {
          ...state.activeBrowserTabIdByProject,
          [normalizedProjectId]: nextActiveTabId,
        },
      };
    });
  },
});
