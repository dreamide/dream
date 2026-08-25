export interface FileTab {
  path: string;
  // Preview tabs (single-click) are replaced by the next previewed file.
  // Pinned tabs (double-click, Enter, or edits) persist until closed.
  pinned: boolean;
}

export interface ProjectFileTabsState {
  activePath: string | null;
  tabs: FileTab[];
}

export type FileTabsState = Record<string, ProjectFileTabsState>;

export type FileTabsAction =
  | { type: "preview"; projectId: string; path: string }
  | { type: "pin"; projectId: string; path: string }
  | { type: "activate"; projectId: string; path: string }
  | { type: "close"; projectId: string; path: string }
  | { type: "reorder"; projectId: string; fromIndex: number; toIndex: number };

export const EMPTY_PROJECT_FILE_TABS: ProjectFileTabsState = {
  activePath: null,
  tabs: [],
};

export const getProjectFileTabs = (
  state: FileTabsState,
  projectId: string | null,
): ProjectFileTabsState =>
  projectId
    ? (state[projectId] ?? EMPTY_PROJECT_FILE_TABS)
    : EMPTY_PROJECT_FILE_TABS;

const reduceProject = (
  state: ProjectFileTabsState,
  action: FileTabsAction,
): ProjectFileTabsState => {
  switch (action.type) {
    case "preview": {
      if (state.tabs.some((tab) => tab.path === action.path)) {
        return state.activePath === action.path
          ? state
          : { ...state, activePath: action.path };
      }

      const previewIndex = state.tabs.findIndex((tab) => !tab.pinned);
      const nextTab: FileTab = { path: action.path, pinned: false };
      const tabs =
        previewIndex === -1
          ? [...state.tabs, nextTab]
          : state.tabs.map((tab, index) =>
              index === previewIndex ? nextTab : tab,
            );

      return { activePath: action.path, tabs };
    }
    case "pin": {
      const existing = state.tabs.find((tab) => tab.path === action.path);
      if (existing) {
        if (existing.pinned && state.activePath === action.path) {
          return state;
        }
        return {
          activePath: action.path,
          tabs: existing.pinned
            ? state.tabs
            : state.tabs.map((tab) =>
                tab.path === action.path ? { ...tab, pinned: true } : tab,
              ),
        };
      }

      // Pinning a file that isn't open replaces the preview slot (if any),
      // mirroring a double-click that follows a single-click.
      const previewIndex = state.tabs.findIndex((tab) => !tab.pinned);
      const nextTab: FileTab = { path: action.path, pinned: true };
      const tabs =
        previewIndex === -1
          ? [...state.tabs, nextTab]
          : state.tabs.map((tab, index) =>
              index === previewIndex ? nextTab : tab,
            );

      return { activePath: action.path, tabs };
    }
    case "activate": {
      if (
        state.activePath === action.path ||
        !state.tabs.some((tab) => tab.path === action.path)
      ) {
        return state;
      }
      return { ...state, activePath: action.path };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.path === action.path);
      if (index === -1) {
        return state;
      }

      const tabs = state.tabs.filter((tab) => tab.path !== action.path);
      if (state.activePath !== action.path) {
        return { ...state, tabs };
      }

      const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
      return { activePath: neighbor?.path ?? null, tabs };
    }
    case "reorder": {
      const { fromIndex, toIndex } = action;
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= state.tabs.length ||
        toIndex >= state.tabs.length
      ) {
        return state;
      }

      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      if (!moved) {
        return state;
      }
      tabs.splice(toIndex, 0, moved);
      return { ...state, tabs };
    }
  }
};

export const fileTabsReducer = (
  state: FileTabsState,
  action: FileTabsAction,
): FileTabsState => {
  const current = state[action.projectId] ?? EMPTY_PROJECT_FILE_TABS;
  const next = reduceProject(current, action);
  if (next === current) {
    return state;
  }

  return { ...state, [action.projectId]: next };
};
