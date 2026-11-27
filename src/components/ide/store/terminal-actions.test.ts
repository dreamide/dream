// The Terminal session owner over a real terminal client on the host socket
// fake: what each lifecycle path and host event does to every piece of a
// session (store maps, output buffer, untouched mark, command observation,
// the shell on its Host).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createFakeHostSocket } from "@/lib/host-socket-fake";
import { createTerminalClient } from "@/lib/terminal-client";
import { TERMINAL_COMMAND_QUIET_MS } from "../terminal-command-refresh";
import {
  hasTerminalScrollback,
  subscribeToTerminalOutput,
} from "../terminal-scrollback";
import { createTerminalSessions } from "../terminal-session";
import { isTerminalSessionUntouched } from "../terminal-untouched";
import type { IdeState } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import {
  BROWSER_TAB_KEYED_STATE,
  CHAT_KEYED_STATE,
  commitWorkspaceRemoval,
  PROJECT_KEYED_PERSISTED_STATE,
  PROJECT_KEYED_RUNTIME_STATE,
  TERMINAL_SESSION_KEYED_STATE,
} from "./project-runtime-state";
import {
  createTerminalActions,
  createTerminalSessionOwner,
} from "./terminal-actions";

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const project = (id: string) => ({
  id,
  path: `/work/${id}`,
  ui: { rightPanelOpen: true, rightPanelView: "terminal" },
});

const setup = async ({ detached = false } = {}) => {
  const fake = createFakeHostSocket();
  const api = {
    terminalDiagnostics: vi.fn(async () => []),
    terminalShells: vi.fn(async () => []),
    terminalStart: vi.fn(async () => ({ status: "running" as const })),
    terminalStop: vi.fn(async (_payload: { sessionId: string }) => true),
    terminalStopAll: vi.fn(async () => true),
  };
  const client = createTerminalClient({ api, socket: fake.socket });
  const refreshProject = vi.fn();
  const store = createStore<IdeState>(
    () =>
      ({
        ...Object.fromEntries(
          [
            ...BROWSER_TAB_KEYED_STATE,
            ...CHAT_KEYED_STATE,
            ...PROJECT_KEYED_PERSISTED_STATE,
            ...PROJECT_KEYED_RUNTIME_STATE,
            ...TERMINAL_SESSION_KEYED_STATE,
          ].map((key) => [key, {}]),
        ),
        projects: [project("project-a")],
        closedProjects: [],
        settings: { shellPath: "" },
        stateHydrated: false,
      }) as unknown as IdeState,
  );
  const owner = createTerminalSessionOwner(store.setState, store.getState, {
    client,
    observation: createTerminalSessions({ refreshProject }),
    isDetached: () => detached,
    localHostSocket: () => fake.socket,
  });
  store.setState({
    ...createTerminalActions(store.setState, store.getState, owner),
    ...createProjectLifecycleActions(store.setState, store.getState, {
      persist: () => {},
      terminals: owner,
    }),
  });
  // What IdeShell does: host events go to the owner.
  client.onData(owner.receiveOutput);
  client.onStatus(owner.receiveStatus);
  await fake.flush();
  fake.transports[0]?.open();
  const transport = () => fake.transports.at(-1);
  const status = (sessionId: string, value: "running" | "stopped") =>
    transport()?.deliver({
      channel: "terminal",
      type: "status",
      sessionId,
      status: value,
    });
  const sessionsOf = (projectId: string) =>
    store.getState().projectTerminalSessionIds[projectId] ?? [];
  return {
    ...fake,
    api,
    owner,
    refreshProject,
    sessionsOf,
    status,
    store,
    transport,
  };
};

test("opening then closing a terminal clears every piece of it and settles its command", async () => {
  const { api, owner, refreshProject, sessionsOf, store, transport } =
    await setup();

  await store.getState().addProjectTerminal("project-a");
  const [sessionId] = sessionsOf("project-a");
  if (!sessionId) throw new Error("terminal not opened");
  expect(api.terminalStart).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/work/project-a", sessionId }),
    undefined,
  );
  expect(store.getState().activeTerminalSessionIdByProject).toEqual({
    "project-a": sessionId,
  });
  expect(store.getState().terminalSessionNames[sessionId]).toBe("Terminal 1");
  expect(store.getState().terminalStatus[sessionId]).toBe("running");
  expect(hasTerminalScrollback(sessionId)).toBe(true);

  owner.input(sessionId, "git commit\r");
  expect(transport()?.sent.at(-1)).toEqual({
    channel: "terminal",
    type: "input",
    sessionId,
    data: "git commit\r",
  });

  await store.getState().closeProjectTerminal("project-a", sessionId);

  const state = store.getState();
  expect(sessionsOf("project-a")).toEqual([]);
  expect(state.activeTerminalSessionIdByProject["project-a"]).toBeNull();
  for (const map of TERMINAL_SESSION_KEYED_STATE) {
    expect(state[map]).not.toHaveProperty(sessionId);
  }
  expect(state.projects[0]?.ui.rightPanelOpen).toBe(false);
  expect(hasTerminalScrollback(sessionId)).toBe(false);
  expect(api.terminalStop).toHaveBeenCalledWith({ sessionId }, undefined);
  expect(refreshProject).toHaveBeenCalledExactlyOnceWith("project-a");
});

test("removing a Project stops its terminals and cancels their pending commands", async () => {
  const { api, owner, refreshProject, sessionsOf, store } = await setup();
  await store.getState().addProjectTerminal("project-a");
  await store.getState().addProjectTerminal("project-a");
  const sessionIds = sessionsOf("project-a");
  vi.useFakeTimers();
  for (const sessionId of sessionIds) owner.input(sessionId, "\r");

  await commitWorkspaceRemoval(store.setState, owner, {
    doc: { projects: [] },
    removedChatIds: [],
    removedProjectIds: ["project-a"],
    closedProjectIds: [],
  } as unknown as Parameters<typeof commitWorkspaceRemoval>[2]);
  vi.advanceTimersByTime(TERMINAL_COMMAND_QUIET_MS);

  expect(api.terminalStop.mock.calls.map(([payload]) => payload)).toEqual(
    sessionIds.map((sessionId) => ({ sessionId })),
  );
  for (const sessionId of sessionIds) {
    expect(hasTerminalScrollback(sessionId)).toBe(false);
  }
  expect(store.getState().projectTerminalSessionIds).toEqual({});
  expect(store.getState().terminalStatus).toEqual({});
  expect(refreshProject).not.toHaveBeenCalled();
});

test("leaving the terminal view discards only the terminals nobody typed into", async () => {
  const { api, owner, sessionsOf, store } = await setup();
  await store.getState().openProjectTerminal("project-a");
  await store
    .getState()
    .addProjectTerminal("project-a", { closeIfUntouched: true });
  const [typed, idle] = sessionsOf("project-a");
  if (!typed || !idle) throw new Error("terminals not opened");
  expect(isTerminalSessionUntouched(typed)).toBe(true);
  // An automatic terminal response is not typing.
  owner.input(idle, "\x1b[24;1R");
  owner.input(typed, "l");

  // What leaving the terminal view asks of the owner (panel-actions.ts).
  owner.discardUntouched("project-a");
  await vi.waitFor(() =>
    expect(api.terminalStop).toHaveBeenCalledWith(
      { sessionId: idle },
      undefined,
    ),
  );

  expect(sessionsOf("project-a")).toEqual([typed]);
  expect(api.terminalStop).toHaveBeenCalledTimes(1);
  expect(store.getState().projects[0]?.ui.rightPanelOpen).toBe(true);
});

test("after a reconnect, a detached host's known session keeps its place and an unknown running one is restored", async () => {
  const { flush, sessionsOf, status, store, timers, transport, transports } =
    await setup({ detached: true });
  await store.getState().addProjectTerminal("project-a");
  const [known] = sessionsOf("project-a");
  if (!known) throw new Error("terminal not opened");

  transports[0]?.close();
  timers[0]?.();
  await flush();
  transport()?.open();
  expect(transport()?.sent[0]).toEqual({
    channel: "host",
    type: "resume",
    cursors: {
      terminal: [{ sessionId: known, generation: null, sequence: 0 }],
    },
  });

  const survivor = "__project_terminal__:project-a:survivor";
  status(known, "running");
  status(survivor, "running");
  status(survivor, "running");

  const state = store.getState();
  expect(sessionsOf("project-a")).toEqual([known, survivor]);
  expect(state.activeTerminalSessionIdByProject["project-a"]).toBe(known);
  expect(state.terminalSessionNames[survivor]).toBe("Terminal 2");
  expect(state.terminalStatus[survivor]).toBe("running");
  expect(hasTerminalScrollback(survivor)).toBe(true);
});

test("an unknown session is ignored when the host was started by this desktop", async () => {
  const { sessionsOf, status, store } = await setup();
  const stranger = "__project_terminal__:project-a:stranger";

  status(stranger, "running");

  expect(sessionsOf("project-a")).toEqual([]);
  expect(store.getState().terminalStatus).toEqual({});
  expect(hasTerminalScrollback(stranger)).toBe(false);
});

test("output is acknowledged by generation and sequence once every view processed it", async () => {
  const { sessionsOf, store, transport } = await setup();
  await store.getState().addProjectTerminal("project-a");
  const [sessionId] = sessionsOf("project-a");
  if (!sessionId) throw new Error("terminal not opened");
  const views: Array<() => void> = [];
  subscribeToTerminalOutput(sessionId, (_chunk, processed) =>
    views.push(processed),
  );
  const acks = () =>
    transport()?.sent.filter((message) => message.type === "ack") ?? [];

  transport()?.deliver({
    channel: "terminal",
    type: "data",
    sessionId,
    generation: "g1",
    sequence: 3,
    chunk: "out",
  });
  expect(acks()).toEqual([]);
  views[0]?.();
  // A notice outside the numbered stream is not acknowledged.
  transport()?.deliver({
    channel: "terminal",
    type: "data",
    sessionId,
    chunk: "notice",
  });
  views[1]?.();

  expect(acks()).toEqual([
    {
      channel: "terminal",
      type: "ack",
      sessionId,
      generation: "g1",
      sequence: 3,
    },
  ]);
});

test("discovery asks the detached host once Projects are known, and restores sessions of known Projects only", async () => {
  const { owner, sessionsOf, status, store, transport } = await setup({
    detached: true,
  });
  const discoveries = () =>
    transport()?.sent.filter((message) => message.type === "discover") ?? [];
  const stop = owner.followDiscovery(store.subscribe);

  expect(discoveries()).toEqual([]);
  store.setState({ stateHydrated: true });
  store.setState({ activeProjectId: "project-a" });
  expect(discoveries()).toEqual([{ channel: "terminal", type: "discover" }]);

  status("__project_terminal__:project-a:kept", "running");
  status("__project_terminal__:project-gone:lost", "running");
  expect(sessionsOf("project-a")).toEqual([
    "__project_terminal__:project-a:kept",
  ]);
  expect(store.getState().projectTerminalSessionIds).not.toHaveProperty(
    "project-gone",
  );
  expect(hasTerminalScrollback("__project_terminal__:project-gone:lost")).toBe(
    false,
  );

  store.setState({
    projects: [...store.getState().projects, project("project-b")],
  } as unknown as Partial<IdeState>);
  expect(discoveries()).toHaveLength(2);
  stop();
});
