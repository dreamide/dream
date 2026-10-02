// SSH hosts after this window reloads: main keeps its connections, so the
// window asks main what is connected instead of assuming nothing is.
import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { HostConnectionState } from "@/types/ide";
import { createHostActions } from "./host-actions";
import type { IdeState } from "./ide-store-types";

const desktop = vi.hoisted(() => ({
  connectHost: vi.fn(async () => ({})),
  disconnectHost: vi.fn(async () => true),
  getHostState: vi.fn(async (_hostId: string) => "idle" as string),
}));

vi.mock("@/lib/electron", () => ({ getDesktopApi: () => desktop }));

const loaded = vi.hoisted(() => new Set<string>());
vi.mock("./ide-store-persistence", () => ({
  forgetLoadedHost: (hostId: string) => loaded.delete(hostId),
  isHostLoaded: (hostId: string) => loaded.has(hostId),
}));

afterEach(() => {
  desktop.connectHost.mockClear();
  desktop.disconnectHost.mockClear();
  desktop.getHostState.mockReset();
  loaded.clear();
});

const host = (id: string) => ({
  hostCommand: "",
  id,
  label: id,
  target: `me@${id}`,
});

const createTestStore = () => {
  const loadHostCatalog = vi.fn(async (hostId: string) => {
    loaded.add(hostId);
  });
  const reloadCatalog = vi.fn(async () => {});
  const store = createStore<IdeState>(
    () =>
      ({
        bumpProjectGitRefreshKey: () => {},
        hosts: {},
        loadHostCatalog,
        projects: [],
        reloadCatalog,
        setSettings: (
          updater: (settings: IdeState["settings"]) => IdeState["settings"],
        ) => store.setState({ settings: updater(store.getState().settings) }),
        settings: {
          ...DEFAULT_SETTINGS,
          sshHosts: [host("a"), host("b"), host("c"), host("d")],
        },
      }) as unknown as IdeState,
  );
  store.setState(createHostActions(store.setState, store.getState));
  return { loadHostCatalog, reloadCatalog, store };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("after a reload, hosts main still has connected come back, and hosts with open projects reconnect", async () => {
  const states: Record<string, HostConnectionState> = {
    a: "connected",
    b: "reconnecting",
    c: "idle",
    d: "idle",
  };
  desktop.getHostState.mockImplementation(async (hostId) => states[hostId]);
  const { loadHostCatalog, store } = createTestStore();

  await store.getState().resumeHosts(["c"]);

  // a: already connected in main; c: had open projects. Not b (on its way)
  // nor d (nothing open, not connected).
  expect(
    desktop.connectHost.mock.calls.map(
      (call) => (call as unknown as [{ hostId: string }])[0].hostId,
    ),
  ).toEqual(["a", "c"]);
  expect(loadHostCatalog.mock.calls.map((call) => call[0]).sort()).toEqual([
    "a",
    "c",
  ]);
  expect(store.getState().hosts.a).toMatchObject({
    loaded: true,
    state: "connected",
  });
  expect(store.getState().hosts.b?.state).toBe("reconnecting");
  expect(store.getState().hosts.d).toBeUndefined();
});

test("a host that connects without this window asking brings its projects in", async () => {
  const { loadHostCatalog, reloadCatalog, store } = createTestStore();

  // Main finishes a reconnect it started before this window reloaded.
  store.getState().setHostStatus({
    error: null,
    hostId: "b",
    state: "reconnecting",
    version: null,
  });
  store.getState().setHostStatus({
    error: null,
    hostId: "b",
    state: "connected",
    version: null,
  });
  await flush();
  expect(loadHostCatalog).toHaveBeenCalledWith("b");
  expect(store.getState().hosts.b).toMatchObject({
    loaded: true,
    state: "connected",
  });

  // A later drop and return reloads what it already has.
  store.getState().setHostStatus({
    error: null,
    hostId: "b",
    state: "reconnecting",
    version: null,
  });
  store.getState().setHostStatus({
    error: null,
    hostId: "b",
    state: "connected",
    version: null,
  });
  await flush();
  expect(reloadCatalog).toHaveBeenCalledWith("b");
  expect(loadHostCatalog).toHaveBeenCalledTimes(1);
});

test("editing a host keeps it, and a live connection reconnects when how it is reached changed", async () => {
  desktop.getHostState.mockImplementation(async () => "idle");
  const { store } = createTestStore();
  const hostIds = () => store.getState().settings.sshHosts.map((h) => h.id);

  // A new name only: same host, no reconnect.
  await store.getState().updateSshHost("a", { label: "Build box" });
  expect(hostIds()).toEqual(["a", "b", "c", "d"]);
  expect(store.getState().settings.sshHosts[0]?.label).toBe("Build box");
  expect(desktop.disconnectHost).not.toHaveBeenCalled();

  // Not connected: a new target is saved, nothing reconnects.
  await store.getState().updateSshHost("a", { target: "me@new-a" });
  expect(desktop.connectHost).not.toHaveBeenCalled();

  // Connected: a new target reconnects there.
  await store.getState().connectHost("a");
  desktop.connectHost.mockClear();
  await store
    .getState()
    .updateSshHost("a", { hostCommand: "~/bin/dream-host" });
  expect(desktop.disconnectHost).toHaveBeenCalledWith("a");
  expect(desktop.connectHost).toHaveBeenCalledWith({
    hostCommand: "~/bin/dream-host",
    hostId: "a",
    target: "me@new-a",
  });
  expect(hostIds()).toEqual(["a", "b", "c", "d"]);
});
