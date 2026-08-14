import { afterEach, beforeEach, expect, test, vi } from "vitest";

const storeActions = vi.hoisted(() => ({
  bumpProjectFilesRefreshKey: vi.fn(),
  bumpProjectGitRefreshKey: vi.fn(),
}));

vi.mock("./ide-store", () => ({
  useIdeStore: {
    getState: () => storeActions,
  },
}));

const {
  flushProjectPanelRefresh,
  PROJECT_PANEL_REFRESH_DELAY_MS,
  scheduleProjectPanelRefresh,
} = await import("./project-panel-refresh");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  storeActions.bumpProjectFilesRefreshKey.mockReset();
  storeActions.bumpProjectGitRefreshKey.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("coalesces a burst of writes into one project refresh", () => {
  scheduleProjectPanelRefresh("project-1");
  vi.advanceTimersByTime(PROJECT_PANEL_REFRESH_DELAY_MS - 1);
  scheduleProjectPanelRefresh("project-1");
  vi.advanceTimersByTime(PROJECT_PANEL_REFRESH_DELAY_MS);

  expect(storeActions.bumpProjectGitRefreshKey).toHaveBeenCalledOnce();
  expect(storeActions.bumpProjectFilesRefreshKey).toHaveBeenCalledOnce();
});

test("keeps refresh timers independent between projects", () => {
  scheduleProjectPanelRefresh("project-1");
  scheduleProjectPanelRefresh("project-2");
  vi.advanceTimersByTime(PROJECT_PANEL_REFRESH_DELAY_MS);

  expect(storeActions.bumpProjectGitRefreshKey).toHaveBeenCalledTimes(2);
  expect(storeActions.bumpProjectGitRefreshKey).toHaveBeenCalledWith(
    "project-1",
  );
  expect(storeActions.bumpProjectGitRefreshKey).toHaveBeenCalledWith(
    "project-2",
  );
});

test("flushing a turn cancels its pending timer", () => {
  scheduleProjectPanelRefresh("project-1");
  flushProjectPanelRefresh("project-1");
  vi.advanceTimersByTime(PROJECT_PANEL_REFRESH_DELAY_MS);

  expect(storeActions.bumpProjectGitRefreshKey).toHaveBeenCalledOnce();
  expect(storeActions.bumpProjectFilesRefreshKey).toHaveBeenCalledOnce();
});
