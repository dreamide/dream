// A window that could not load the workspace holds empty defaults; saving
// them would overwrite the user's settings and projects. It saves nothing.
import { expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { PersistedIdeState } from "@/types/ide";

const desktop = vi.hoisted(() => ({
  loadState: vi.fn(async () => {
    throw new Error("Database is locked.");
  }),
  saveWorkspaceChanges: vi.fn(async () => true),
}));
vi.mock("@/lib/electron", () => ({ getDesktopApi: () => desktop }));

const {
  isWorkspaceLoaded,
  loadPersistedIdeState,
  pushPersistedCatalogs,
  savePersistedWorkspace,
} = await import("./ide-store-persistence");

test("after a failed load, nothing is saved", async () => {
  const state = await loadPersistedIdeState();

  // It tried more than once, then gave up showing defaults.
  expect(desktop.loadState.mock.calls.length).toBeGreaterThan(1);
  expect(state.settings.sshHosts).toEqual(DEFAULT_SETTINGS.sshHosts);
  expect(isWorkspaceLoaded()).toBe(false);

  savePersistedWorkspace(state as PersistedIdeState, { rows: true });
  pushPersistedCatalogs(state as PersistedIdeState, {
    chats: [],
    closedProjects: [],
    projects: [],
  });
  expect(desktop.saveWorkspaceChanges).not.toHaveBeenCalled();
});
