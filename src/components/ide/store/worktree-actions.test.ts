import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createFakeApiClient,
  type FakeApiHandlers,
  fakeApiError,
} from "@/lib/api-client-fake";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { BrowserTabState, ProjectGitWorktreeInfo } from "@/types/ide";
import { normalizeProjectPathKey } from "../ide-state";
import type { IdeState } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import {
  BROWSER_TAB_KEYED_STATE,
  CHAT_KEYED_STATE,
  PROJECT_KEYED_PERSISTED_STATE,
  PROJECT_KEYED_RUNTIME_STATE,
  TERMINAL_SESSION_KEYED_STATE,
} from "./project-runtime-state";
import { createRuntimeActions } from "./runtime-actions";
import {
  createWorktreeActions,
  createWorktreeRecord,
} from "./worktree-actions";

const WORKTREE_PATH = "/workspace/worktrees/source-feature";

const createTestStore = (handlers: FakeApiHandlers = {}) => {
  const api = createFakeApiClient(handlers);
  const parent = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const worktree = createProjectConfig(WORKTREE_PATH, DEFAULT_SETTINGS);
  worktree.worktree = createWorktreeRecord({
    baseRef: "main",
    branch: "feature",
    mainWorktreePath: parent.path,
    managed: true,
    parentProjectId: parent.id,
    repoRoot: parent.path,
  });
  const staleClosedWorktree = createProjectConfig(
    `${WORKTREE_PATH}/`,
    DEFAULT_SETTINGS,
  );
  const worktreeChat = createChatConfig(worktree, { title: "Worktree chat" });
  const parentChat = createChatConfig(parent, { title: "Parent chat" });
  const messages = [
    { id: "message-one", parts: [{ text: "one", type: "text" }], role: "user" },
  ] as UIMessage[];

  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: worktree.id,
        chats: [worktreeChat, parentChat],
        chatSort: "recent",
        closedProjects: [staleClosedWorktree],
        completedChatIds: {},
        draftChatIdByProject: {},
        messagesByChatId: {
          [parentChat.id]: messages,
          [worktreeChat.id]: messages,
        },
        activeBrowserTabIdByProject: {},
        activeTerminalSessionIdByProject: {},
        awaitingAnswerChatIds: {},
        browserLoading: {},
        browserTabsByProject: {},
        nextTerminalOrdinalByProject: {},
        pendingChatSubmitByChatId: {},
        projectFileOpenRequests: {},
        projectFilesRefreshKeys: {},
        projectGitRefreshKeys: {},
        projectTerminalPanelOpenByProject: {},
        projectTerminalSessionIds: {},
        terminalSessionNames: {},
        terminalShell: {},
        terminalStatus: {},
        terminalTransport: {},
        projects: [parent, worktree],
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createProjectLifecycleActions(store.setState, store.getState),
    ...createWorktreeActions(store.setState, store.getState, {
      api: api.client,
    }),
    ...createRuntimeActions(store.setState),
  });

  return {
    calls: api.calls,
    parent,
    parentChat,
    store,
    worktree,
    worktreeChat,
  };
};

const hasProjectPath = (state: IdeState, projectPath: string) =>
  [...state.projects, ...state.closedProjects].some(
    (project) =>
      normalizeProjectPathKey(project.path) ===
      normalizeProjectPathKey(projectPath),
  );

const cleanupResponse = {
  branch: "feature",
  branchDeleted: true,
  branchDeleteError: null,
  path: WORKTREE_PATH,
  pruned: false,
  removed: true,
} as const;

test("forgetWorktree sends the recorded branch and stops the worktree's terminals", async () => {
  const { calls, parent, store, worktree } = createTestStore({
    gitWorktreeCleanup: () => cleanupResponse,
  });

  const result = await store.getState().forgetWorktree({
    deleteBranch: true,
    mainWorktreePath: parent.path,
    worktreePath: worktree.path,
  });

  assert.equal(result.branchDeleted, true);
  assert.deepEqual(calls, [
    {
      name: "gitWorktreeCleanup",
      request: {
        branch: "feature",
        deleteBranch: true,
        force: false,
        projectPath: parent.path,
        worktreePath: worktree.path,
      },
    },
  ]);
  // The app's own record is left for purgeWorktreeProject.
  assert.equal(hasProjectPath(store.getState(), WORKTREE_PATH), true);
});

test("purgeWorktreeProject drops the worktree, its chats, and activates the parent", async () => {
  const { parent, parentChat, store, worktree, worktreeChat } = createTestStore(
    { gitWorktreeCleanup: () => cleanupResponse },
  );

  await store.getState().forgetWorktree({
    mainWorktreePath: parent.path,
    worktreePath: worktree.path,
  });
  store.getState().purgeWorktreeProject(worktree.path);

  const state = store.getState();
  assert.equal(hasProjectPath(state, WORKTREE_PATH), false);
  assert.deepEqual(
    state.projects.map((project) => project.id),
    [parent.id],
  );
  assert.deepEqual(
    state.chats.map((chat) => chat.id),
    [parentChat.id],
  );
  assert.equal(state.messagesByChatId[worktreeChat.id], undefined);
  assert.ok(state.messagesByChatId[parentChat.id]);
  // The parent is the default activation target, and its status is stale.
  assert.equal(state.activeProjectId, parent.id);
  assert.equal(state.projectGitRefreshKeys[parent.id], 1);
});

test("forgetWorktree answers as gone when git no longer knows the worktree", async () => {
  const { parent, store, worktree } = createTestStore({
    gitWorktreeCleanup: () => {
      throw fakeApiError(
        "gitWorktreeCleanup",
        404,
        "Worktree was not found for this repository.",
      );
    },
  });

  const result = await store.getState().forgetWorktree({
    mainWorktreePath: parent.path,
    worktreePath: worktree.path,
  });

  assert.deepEqual(result, {
    branch: "feature",
    branchDeleted: false,
    branchDeleteError: null,
    path: worktree.path,
    pruned: true,
    removed: true,
  });
});

test("forgetWorktree rethrows other failures without touching state", async () => {
  const { parent, store, worktree } = createTestStore({
    gitWorktreeCleanup: () => {
      throw fakeApiError(
        "gitWorktreeCleanup",
        400,
        "fatal: 'feature' contains modified or untracked files, use --force to delete it",
      );
    },
  });
  const originalState = store.getState();

  await assert.rejects(
    store.getState().forgetWorktree({
      mainWorktreePath: parent.path,
      worktreePath: worktree.path,
    }),
    /modified or untracked files/,
  );

  const state = store.getState();
  assert.equal(state.projects, originalState.projects);
  assert.equal(state.chats, originalState.chats);
  assert.equal(state.closedProjects, originalState.closedProjects);
  assert.equal(state.activeProjectId, worktree.id);
});

test("purgeWorktreeProject falls back when the activation target is missing", () => {
  const { parent, store, worktree } = createTestStore();

  store.getState().purgeWorktreeProject(worktree.path, {
    activateProjectId: "missing-project",
  });

  const state = store.getState();
  assert.equal(hasProjectPath(state, WORKTREE_PATH), false);
  assert.equal(state.activeProjectId, parent.id);
  assert.equal(state.projectGitRefreshKeys[parent.id], undefined);
});

test("purging a worktree leaves no state keyed by it, its sessions, tabs or chats", () => {
  const { store, worktree, worktreeChat } = createTestStore();
  const sessionId = `__project_terminal__:${worktree.id}:1`;
  const tab = { id: "tab-1" } as BrowserTabState;
  store.setState({
    activeBrowserTabIdByProject: { [worktree.id]: tab.id },
    activeTerminalSessionIdByProject: { [worktree.id]: sessionId },
    awaitingAnswerChatIds: { [worktreeChat.id]: true },
    browserLoading: { [tab.id]: true },
    browserTabsByProject: { [worktree.id]: [tab] },
    completedChatIds: { [worktreeChat.id]: true },
    draftChatIdByProject: { [worktree.id]: null },
    nextTerminalOrdinalByProject: { [worktree.id]: 2 },
    pendingChatSubmitByChatId: {
      [worktreeChat.id]: { text: "queued" } as never,
    },
    projectFileOpenRequests: {
      [worktree.id]: { filePath: "a.ts", requestId: 1 },
    },
    projectFilesRefreshKeys: { [worktree.id]: 1 },
    projectGitLogPanelOpenByProject: { [worktree.id]: true },
    projectGitRefreshKeys: { [worktree.id]: 1 },
    projectTerminalPanelOpenByProject: { [worktree.id]: true },
    projectTerminalSessionIds: { [worktree.id]: [sessionId] },
    streamingChatIds: { [worktreeChat.id]: true },
    terminalSessionNames: { [sessionId]: "shell" },
    terminalShell: { [sessionId]: "bash" },
    terminalStatus: { [sessionId]: "running" },
    terminalTransport: { [sessionId]: "pty" },
    titleGeneratingChatIds: { [worktreeChat.id]: true },
  });

  store.getState().purgeWorktreeProject(worktree.path);

  const state = store.getState();
  const keysLeft = (maps: readonly (keyof IdeState)[], key: string) =>
    maps.filter((map) => key in (state[map] as Record<string, unknown>));
  assert.deepEqual(keysLeft(PROJECT_KEYED_RUNTIME_STATE, worktree.id), []);
  assert.deepEqual(keysLeft(PROJECT_KEYED_PERSISTED_STATE, worktree.id), []);
  assert.deepEqual(keysLeft(TERMINAL_SESSION_KEYED_STATE, sessionId), []);
  assert.deepEqual(keysLeft(BROWSER_TAB_KEYED_STATE, tab.id), []);
  assert.deepEqual(keysLeft(CHAT_KEYED_STATE, worktreeChat.id), []);
});

test("closing a project drops its runtime state but keeps its browser tabs", () => {
  const { store, worktree } = createTestStore();
  const sessionId = `__project_terminal__:${worktree.id}:1`;
  const tab = { id: "tab-1" } as BrowserTabState;
  store.setState({
    activeBrowserTabIdByProject: { [worktree.id]: tab.id },
    browserLoading: { [tab.id]: true },
    browserTabsByProject: { [worktree.id]: [tab] },
    projectGitRefreshKeys: { [worktree.id]: 3 },
    projectTerminalSessionIds: { [worktree.id]: [sessionId] },
    terminalStatus: { [sessionId]: "running" },
  });

  store.getState().closeProject(worktree.id);

  const state = store.getState();
  assert.equal(state.projectGitRefreshKeys[worktree.id], undefined);
  assert.equal(state.projectTerminalSessionIds[worktree.id], undefined);
  assert.equal(state.terminalStatus[sessionId], undefined);
  assert.equal(state.browserLoading[tab.id], undefined);
  assert.deepEqual(state.browserTabsByProject[worktree.id], [tab]);
  assert.equal(state.activeBrowserTabIdByProject[worktree.id], tab.id);
  assert.equal(
    state.closedProjects.some((project) => project.id === worktree.id),
    true,
  );
});

test("completeWorktreeProject merges against the recorded base and refreshes the parent", async () => {
  const { calls, parent, store, worktree } = createTestStore({
    gitWorktreeMerge: () => ({
      baseBranch: "main",
      branch: "feature",
      fastForward: true,
      mainWorktreePath: parent.path,
      mergeCommit: "abc123",
      previousMainBranch: "main",
      status: "merged" as const,
    }),
  });

  const result = await store.getState().completeWorktreeProject(worktree.id, {
    acknowledgeUncommitted: true,
  });

  assert.equal(result.status, "merged");
  assert.deepEqual(calls, [
    {
      name: "gitWorktreeMerge",
      request: {
        acknowledgeUncommitted: true,
        baseRef: "main",
        projectPath: worktree.path,
      },
    },
  ]);
  assert.equal(store.getState().projectGitRefreshKeys[parent.id], 1);
});

test("completeWorktreeProject leaves the parent alone on a conflict", async () => {
  const { parent, store, worktree } = createTestStore({
    gitWorktreeMerge: () => ({
      baseBranch: "main",
      branch: "feature",
      conflictingFiles: ["README.md"],
      mainWorktreePath: parent.path,
      previousMainBranch: "main",
      status: "conflict" as const,
    }),
  });

  const result = await store
    .getState()
    .completeWorktreeProject(worktree.id, {});

  assert.equal(result.status, "conflict");
  assert.equal(store.getState().projectGitRefreshKeys[parent.id], undefined);
});

test("createWorktreeProject can open the worktree without taking focus", async () => {
  const backgroundPath = "/workspace/background-worktree";
  const { parent, store } = createTestStore({
    gitWorktreeCreate: ({ branchName, projectPath }) => ({
      baseRef: "main",
      branch: branchName,
      mainWorktreePath: projectPath,
      path:
        branchName === "background"
          ? backgroundPath
          : "/workspace/foreground-worktree",
      repoRoot: projectPath,
    }),
  });
  store.setState({ activeProjectId: parent.id });

  const created = await store.getState().createWorktreeProject(parent.id, {
    activate: false,
    branchName: "background",
  });

  const state = store.getState();
  assert.ok(created?.projectId);
  assert.equal(hasProjectPath(state, backgroundPath), true);
  assert.equal(state.activeProjectId, parent.id);
  const opened = state.projects.find(
    (project) => project.id === created.projectId,
  );
  assert.equal(opened?.worktree?.branch, "background");
  assert.equal(opened?.worktree?.parentProjectId, parent.id);
  assert.equal(opened?.worktree?.managed, true);
  store.getState().setActiveProjectId(created.projectId);
  assert.equal(store.getState().activeProjectId, created.projectId);

  // The default still switches to the new worktree.
  const foreground = await store
    .getState()
    .createWorktreeProject(parent.id, { branchName: "feature-two" });
  assert.equal(store.getState().activeProjectId, foreground?.projectId);
});

const listedWorktree = (
  worktreePath: string,
  branch: string | null = "listed",
): ProjectGitWorktreeInfo => ({
  appManaged: true,
  bare: false,
  branch,
  commit: "abc123",
  detached: branch === null,
  locked: false,
  path: worktreePath,
  prunable: false,
});

test("attachWorktreeProject opens a listed worktree as a worktree of its main checkout", () => {
  const { parent, store } = createTestStore();
  const listedPath = "/workspace/worktrees/source-listed";

  store.getState().attachWorktreeProject(listedWorktree(listedPath), {
    mainWorktreePath: parent.path,
    repoRoot: parent.path,
  });

  const opened = store
    .getState()
    .projects.find((project) => project.path === listedPath);
  assert.equal(opened?.worktree?.branch, "listed");
  assert.equal(opened?.worktree?.parentProjectId, parent.id);
  assert.equal(opened?.worktree?.baseRef, null);
  assert.equal(store.getState().activeProjectId, opened?.id);
});

test("attachWorktreeProject fills in worktree info on an open project that lacks it", () => {
  const { parent, store } = createTestStore();
  const listedPath = "/workspace/worktrees/source-listed";
  store.getState().addProject(listedPath);
  assert.equal(
    store.getState().projects.find((project) => project.path === listedPath)
      ?.worktree,
    null,
  );

  store.getState().attachWorktreeProject(listedWorktree(listedPath), {
    mainWorktreePath: parent.path,
    repoRoot: parent.path,
  });

  assert.equal(
    store.getState().projects.find((project) => project.path === listedPath)
      ?.worktree?.branch,
    "listed",
  );
});

test("attachWorktreeProject keeps the worktree info recorded at creation", () => {
  const { parent, store, worktree } = createTestStore();

  store.getState().attachWorktreeProject(listedWorktree(WORKTREE_PATH), {
    mainWorktreePath: parent.path,
    repoRoot: parent.path,
  });

  const opened = store
    .getState()
    .projects.find((project) => project.id === worktree.id);
  assert.equal(opened?.worktree?.branch, "feature");
  assert.equal(opened?.worktree?.baseRef, "main");
});

test("attachWorktreeProject opens a detached worktree as a plain folder", () => {
  const { parent, store } = createTestStore();
  const listedPath = "/workspace/worktrees/source-detached";

  store.getState().attachWorktreeProject(listedWorktree(listedPath, null), {
    mainWorktreePath: parent.path,
    repoRoot: parent.path,
  });

  assert.equal(
    store.getState().projects.find((project) => project.path === listedPath)
      ?.worktree,
    null,
  );
});

test("attachWorktreeProject opens a worktree listed on an SSH host on that host", () => {
  const { parent, store } = createTestStore();
  const listedPath = "/workspace/worktrees/source-listed";

  store.getState().attachWorktreeProject(listedWorktree(listedPath), {
    hostId: "devbox",
    mainWorktreePath: parent.path,
    repoRoot: parent.path,
  });

  const opened = store
    .getState()
    .projects.find((project) => project.path === listedPath);
  assert.equal(opened?.hostId, "devbox");
  // The local project at the same path is not its parent: that is another
  // machine's folder.
  assert.equal(opened?.worktree?.parentProjectId, null);
});
