// SSH hosts after this window reloads: main keeps its connections, so the
// window asks main what is connected instead of assuming nothing is.
import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { connectionSupervisor } from "@/lib/connections/runtime";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { HostConnectionState, SavedHostConnection } from "@/types/ide";
import { catalogBaselines } from "./catalog-baselines";
import { connectionStatusOf, createHostActions } from "./host-actions";
import { createHostCatalogLifecycle } from "./host-catalog-lifecycle";
import { replaceHostActivity } from "./host-chat-activity";
import type { IdeState } from "./ide-store-types";
import {
  BROWSER_TAB_KEYED_STATE,
  CHAT_KEYED_STATE,
  PROJECT_KEYED_PERSISTED_STATE,
  PROJECT_KEYED_RUNTIME_STATE,
  TERMINAL_SESSION_KEYED_STATE,
} from "./project-runtime-state";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";

const desktop = vi.hoisted(() => ({
  connectHost: vi.fn(async () => ({})),
  disconnectHost: vi.fn(async () => true),
  getHostState: vi.fn(async (_hostId: string) => "idle" as string),
}));

vi.mock("@/lib/electron", () => ({
  desktopErrorMessage: (error: Error) => error.message,
  getDesktopApi: () => desktop,
}));

// The hosts a test's catalog load gave a baseline, forgotten after it.
const adopted = new Set<string>();

afterEach(() => {
  desktop.connectHost.mockClear();
  desktop.disconnectHost.mockClear();
  desktop.getHostState.mockReset();
  for (const hostId of adopted) catalogBaselines.forget(hostId);
  adopted.clear();
});

const host = (id: string) => ({
  id,
  label: id,
  target: `me@${id}`,
});

/**
 * A store with the host actions, its catalog loads faked. `dropProject`
 * replaces how the Terminal session owner stops a project's terminals.
 */
const createTestStore = ({
  dropProject,
}: {
  dropProject?: TerminalSessionOwner["dropProject"];
} = {}) => {
  const loadHostCatalog = vi.fn(async (hostId: string) => {
    catalogBaselines.adopt(hostId, {
      chats: [],
      closedProjects: [],
      projects: [],
    });
    adopted.add(hostId);
  });
  const reloadCatalog = vi.fn(async () => {});
  const persist = vi.fn();
  const store = createStore<IdeState>(
    () =>
      ({
        bumpProjectGitRefreshKey: () => {},
        hosts: {},
        projects: [],
        setSettings: (
          updater: (settings: IdeState["settings"]) => IdeState["settings"],
        ) => store.setState({ settings: updater(store.getState().settings) }),
        settings: {
          ...DEFAULT_SETTINGS,
          sshHosts: [host("a"), host("b"), host("c"), host("d")],
        },
      }) as unknown as IdeState,
  );
  const terminals = createTerminalSessionOwner(store.setState, store.getState);
  const hosts = createHostActions(store.setState, store.getState, {
    catalogs: createHostCatalogLifecycle(store.setState, store.getState, {
      load: loadHostCatalog,
      reload: reloadCatalog,
    }),
    persist,
    terminals: dropProject ? { ...terminals, dropProject } : terminals,
  });
  store.setState(hosts.actions);
  return { hosts, loadHostCatalog, persist, reloadCatalog, store };
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
  const { hosts, loadHostCatalog, store } = createTestStore();

  await hosts.resumeHosts(["c"]);

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
  const { hosts, loadHostCatalog, reloadCatalog, store } = createTestStore();

  // Main finishes a reconnect it started before this window reloaded.
  hosts.setHostStatus({
    error: null,
    hostId: "b",
    state: "reconnecting",
    version: null,
  });
  hosts.setHostStatus({
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
  hosts.setHostStatus({
    error: null,
    hostId: "b",
    state: "reconnecting",
    version: null,
  });
  hosts.setHostStatus({
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
    expectedIdentity: null,
    hostId: "a",
    routes: [{ id: "ssh:a", kind: "ssh", target: "me@newer-a" }],
  });
  expect(hostIds()).toEqual(["a", "b", "c", "d"]);
});

test("a saved connection connects over its routes to dial, pinned to its host", async () => {
  const { store } = createTestStore();
  const saved: SavedHostConnection = {
    version: 1,
    id: "conn",
    hostId: "host_a",
    fingerprint: "SHA256:a",
    verifiedAt: null,
    routes: [
      { id: "ssh:b", kind: "ssh", sshHostId: "b" },
      { id: "ssh:gone", kind: "ssh", sshHostId: "gone" },
      {
        id: "https:1",
        kind: "https",
        origin: "https://host.example",
        credentialId: "cred-1",
      },
    ],
  };
  store.setState({ hostConnections: [saved] });

  await store.getState().connectHost("conn");

  expect(desktop.connectHost).toHaveBeenCalledWith({
    expectedIdentity: { hostId: "host_a", fingerprint: "SHA256:a" },
    hostId: "conn",
    routes: [
      { id: "ssh:b", kind: "ssh", target: "me@b" },
      {
        id: "https:1",
        kind: "https",
        origin: "https://host.example",
        credentialId: "cred-1",
      },
    ],
  });
});

test("merging two connections retains activity until the surviving Host replaces it", async () => {
  const { store } = createTestStore();
  const identity = { hostId: "same-host", fingerprint: "fp" };
  store.setState({
    closedProjects: [],
    hostConnections: [
      {
        ...identity,
        id: "b",
        routes: [{ id: "ssh:b", kind: "ssh", sshHostId: "b" }],
        verifiedAt: null,
        version: 1,
      },
    ],
    hostRunningChatIds: { running: "a", unrelated: "c" },
    hostAwaitingApprovalChatIds: { waiting: "a" },
  });
  desktop.connectHost.mockResolvedValueOnce(identity);
  await store.getState().connectHost("a");

  expect(store.getState().hostRunningChatIds).toEqual({
    running: "b",
    unrelated: "c",
  });
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({
    waiting: "b",
  });
  store.setState((state) => replaceHostActivity(state, "b", {}));
  expect(store.getState().hostRunningChatIds).toEqual({ unrelated: "c" });
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({});
});

test("a connection with nothing to dial is not sent to main", async () => {
  const { store } = createTestStore();

  expect(await store.getState().connectHost("gone")).toBe(false);

  expect(desktop.connectHost).not.toHaveBeenCalled();
  expect(store.getState().hosts.gone).toMatchObject({
    error: "This connection is not in Settings.",
    state: "failed",
  });
});

test.each([
  ["identity", "incompatible"],
  ["protocol", "incompatible"],
  ["unauthorized", "unauthorized"],
  [null, "offline"],
] as const)("a connection main refused for %s is %s, from its status alone", (refusal, status) => {
  const { hosts, loadHostCatalog } = createTestStore();
  const error =
    "This route reaches a different host than the saved connection.";

  hosts.setHostStatus({
    error,
    hostId: "c",
    refusal,
    state: "failed",
    version: null,
  });

  expect(connectionSupervisor.get("c")).toMatchObject({ error, status });
  expect(loadHostCatalog).not.toHaveBeenCalled();
  connectionSupervisor.forget("c");
});

test("a connect's rejection keeps the refusal main reported with it", async () => {
  const { hosts, store } = createTestStore();
  const error = "The route refused catalog access (401).";
  desktop.connectHost.mockImplementationOnce(async () => {
    // Main's status for the attempt, then the attempt's rejection.
    hosts.setHostStatus({
      error,
      hostId: "d",
      refusal: "unauthorized",
      state: "failed",
      version: null,
    });
    throw new Error(error);
  });

  expect(await store.getState().connectHost("d")).toBe(false);

  expect(store.getState().hosts.d).toMatchObject({ error, state: "failed" });
  expect(connectionSupervisor.get("d").status).toBe("unauthorized");
  connectionSupervisor.forget("d");
});

test("only a failed connection is refused", () => {
  expect(connectionStatusOf("failed", "identity")).toBe("incompatible");
  expect(connectionStatusOf("reconnecting", "identity")).toBe("reconnecting");
  expect(connectionStatusOf("connected", "unauthorized")).toBe("ready");
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
  const { store } = createTestStore({
    dropProject: async (projectId: string) => {
      const sessions =
        store.getState().projectTerminalSessionIds[projectId] ?? [];
      events.push(...sessions.map((sessionId) => `stop ${sessionId}`));
    },
  });
  store.setState({
    ...registeredMaps,
    activeProjectId: remote.id,
    chats: [localChat, remoteChat],
    closedProjects: [],
    hosts: { a: { error: null, loaded: true, state: hostState } },
    projectGitRefreshKeys: { [local.id]: 1, [remote.id]: 2 },
    projectTerminalSessionIds: { [remote.id]: ["remote-session"] },
    projects: [
      { ...local, ui: { ...local.ui, activeChatId: localChat.id } },
      { ...remote, ui: { ...remote.ui, activeChatId: remoteChat.id } },
    ],
    terminalStatus: { "remote-session": "running" },
  } as unknown as Partial<IdeState>);
  return { events, local, localChat, store };
};

test("removing an SSH host stops its terminals before disconnecting, and takes its projects out with their runtime state", async () => {
  const { events, local, localChat, store } =
    createStoreWithHostProject("connected");
  store.setState({
    hostRunningChatIds: { orphan: "a", [localChat.id]: "local" },
    hostAwaitingApprovalChatIds: { orphan: "a" },
  });

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
  expect(state.hostRunningChatIds).toEqual({ [localChat.id]: "local" });
  expect(state.hostAwaitingApprovalChatIds).toEqual({});
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

test("renaming a saved connection keeps its name, and an empty name goes back to its route's", () => {
  const { persist, store } = createTestStore();
  store.setState({
    hostConnections: [
      {
        version: 1,
        id: "paired",
        hostId: "host-1",
        fingerprint: "fp",
        label: "https://caozilla.example",
        verifiedAt: null,
        routes: [
          {
            id: "r1",
            kind: "https",
            origin: "https://caozilla.example",
            credentialId: "c1",
          },
        ],
      },
    ],
  } as Partial<IdeState>);
  const { renameHostConnection } = store.getState();

  renameHostConnection("paired", "  caozilla  ");
  expect(store.getState().hostConnections[0]?.label).toBe("caozilla");
  expect(persist).toHaveBeenCalledTimes(1);

  renameHostConnection("paired", "caozilla");
  expect(persist).toHaveBeenCalledTimes(1);

  renameHostConnection("paired", " ");
  expect(store.getState().hostConnections[0]).not.toHaveProperty("label");
  expect(persist).toHaveBeenCalledTimes(2);

  expect(() => renameHostConnection("unknown", "x")).toThrow();
});
