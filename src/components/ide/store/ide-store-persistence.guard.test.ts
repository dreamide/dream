// A window that could not load the workspace holds empty defaults; saving
// them would overwrite the user's settings and projects. It saves nothing.
import { expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";

const desktop = vi.hoisted(() => ({
  loadState: vi.fn(async () => {
    throw new Error("Database is locked.");
  }),
  saveWorkspaceChanges: vi.fn(async () => true),
}));
vi.mock("@/lib/electron", () => ({ getDesktopApi: () => desktop }));

const { loadPersistedIdeState, savePersistedWorkspace } = await import(
  "./ide-store-persistence"
);

test("after a failed load, nothing is saved", async () => {
  const { homeCatalog, state, workspaceLoaded } = await loadPersistedIdeState();

  // It tried more than once, then gave up showing defaults.
  expect(desktop.loadState.mock.calls.length).toBeGreaterThan(1);
  expect(state.settings.sshHosts).toEqual(DEFAULT_SETTINGS.sshHosts);
  // Nothing says the workspace was read, and no host's catalog came with
  // it, so no host gets a baseline to send changes to (the store's save
  // sends hosts nothing while the workspace is unread).
  expect(workspaceLoaded).toBe(false);
  expect(homeCatalog).toBeNull();

  savePersistedWorkspace(state, { hostIds: new Set(["local"]), rows: true });
  expect(desktop.saveWorkspaceChanges).not.toHaveBeenCalled();
});
