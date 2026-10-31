// SSH hosts after this window reloads: main keeps its connections, so the
// window asks main what is connected instead of assuming nothing is.
import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { HostConnectionState } from "@/types/ide";
import { createHostActions } from "./host-actions";
import type { IdeState } from "./ide-store-types";
import {
  BROWSER_TAB_KEYED_STATE,
  CHAT_KEYED_STATE,
  PROJECT_KEYED_PERSISTED_STATE,
  PROJECT_KEYED_RUNTIME_STATE,
  TERMINAL_SESSION_KEYED_STATE,
} from "./project-runtime-state";

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
  await store.getState().updateSshHost("a", { target: "me@newer-a" });
  // The adapter replaces edited routes while keeping healthy fallbacks.
  expect(desktop.disconnectHost).not.toHaveBeenCalled();
  expect(desktop.connectHost).toHaveBeenCalledWith({
    expectedFingerprint: null,
    expectedHostId: null,
    hostId: "a",
    target: "me@newer-a",
  });
  expect(hostIds()).toEqual(["a", "b", "c", "d"]);
});

/** A store with one local and one host-"a" project, each with a chat. */
const createStoreWithHostProject = (hostState: HostConnectionState) => {
  const local = createProjectConfig("/local/app", DEFAULT_SETTINGS);
  const remote = {
    ...createProjectConfig("/srv/app", DEFAULT_SETTINGS),
    hostId: "a",
  };
  const localChat = createChatConfig(local, { title: "Local" });
  const remoteChat = createChatConfig(remote, { title: "Remote" });
  const registeredMaps = Object.fromEntries(
    [
      ...BROWSER_TAB_KEYED_STATE,
      ...CHAT_KEYED_STATE,
      ...PROJECT_KEYED_PERSISTED_STATE,
      ...PROJECT_KEYED_RUNTIME_STATE,
      ...TERMINAL_SESSION_KEYED_STATE,
    ].map((key) => [key, {}]),
  );
  const events: string[] = [];
  desktop.disconnectHost.mockImplementationOnce(async () => {
    events.push("disconnect");
    return true;
  });
  const { store } = createTestStore();
  store.setState({
    ...registeredMaps,
    activeProjectId: remote.id,
    chats: [localChat, remoteChat],
    closedProjects: [],
    hosts: { a: { error: null, loaded: true, state: hostState } },
    persist: () => {},
    projectGitRefreshKeys: { [local.id]: 1, [remote.id]: 2 },
    projectTerminalSessionIds: { [remote.id]: ["remote-session"] },
    projects: [
      { ...local, ui: { ...local.ui, activeChatId: localChat.id } },
      { ...remote, ui: { ...remote.ui, activeChatId: remoteChat.id } },
    ],
    stopProjectTerminals: async (projectId: string) => {
      const sessions =
        store.getState().projectTerminalSessionIds[projectId] ?? [];
      events.push(...sessions.map((sessionId) => `stop ${sessionId}`));
    },
    terminalStatus: { "remote-session": "running" },
  } as unknown as Partial<IdeState>);
  return { events, local, localChat, store };
};

test("removing an SSH host stops its terminals before disconnecting, and takes its projects out with their runtime state", async () => {
  const { events, local, localChat, store } =
    createStoreWithHostProject("connected");

  await store.getState().removeSshHost("a");

  expect(events).toEqual(["stop remote-session", "disconnect"]);
  const state = store.getState();
  expect(state.projects.map((project) => project.id)).toEqual([local.id]);
  expect(state.chats.map((chat) => chat.id)).toEqual([localChat.id]);
  expect(state.activeProjectId).toBe(local.id);
  expect(state.projectGitRefreshKeys).toEqual({ [local.id]: 1 });
  expect(state.projectTerminalSessionIds).toEqual({});
  expect(state.terminalStatus).toEqual({});
  expect(state.hosts).toEqual({});
  expect(state.settings.sshHosts.map((item) => item.id)).not.toContain("a");
});

test("removing an SSH host that is not connected does not ask it to stop anything", async () => {
  const { events, local, store } = createStoreWithHostProject("disconnected");

  await store.getState().removeSshHost("a");

  expect(events).toEqual(["disconnect"]);
  expect(store.getState().projects.map((project) => project.id)).toEqual([
    local.id,
  ]);
  expect(store.getState().projectTerminalSessionIds).toEqual({});
});
