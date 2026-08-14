import { useIdeStore } from "./ide-store";

export const PROJECT_PANEL_REFRESH_DELAY_MS = 750;

const pendingProjectRefreshes = new Map<string, number>();

const refreshProjectPanels = (projectId: string) => {
  const state = useIdeStore.getState();
  state.bumpProjectGitRefreshKey(projectId);
  state.bumpProjectFilesRefreshKey(projectId);
};

export const scheduleProjectPanelRefresh = (projectId: string) => {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return;
  }

  const pendingRefresh = pendingProjectRefreshes.get(normalizedProjectId);
  if (pendingRefresh !== undefined) {
    window.clearTimeout(pendingRefresh);
  }

  pendingProjectRefreshes.set(
    normalizedProjectId,
    window.setTimeout(() => {
      pendingProjectRefreshes.delete(normalizedProjectId);
      refreshProjectPanels(normalizedProjectId);
    }, PROJECT_PANEL_REFRESH_DELAY_MS),
  );
};

export const flushProjectPanelRefresh = (projectId: string) => {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return;
  }

  const pendingRefresh = pendingProjectRefreshes.get(normalizedProjectId);
  if (pendingRefresh !== undefined) {
    window.clearTimeout(pendingRefresh);
    pendingProjectRefreshes.delete(normalizedProjectId);
  }

  refreshProjectPanels(normalizedProjectId);
};
