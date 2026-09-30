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
import { normalizeProjectPathKey } from "../ide-state";
import type { IdeState } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createRuntimeActions } from "./runtime-actions";

const WORKTREE_PATH = "/workspace/worktrees/source-feature";

const createTestStore = (handlers: FakeApiHandlers = {}) => {
  const api = createFakeApiClient({
    checkpointDeleteProject: () => ({ deleted: true }),
    ...handlers,
  });
  const parent = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const worktree = createProjectConfig(WORKTREE_PATH, DEFAULT_SETTINGS);
  worktree.worktree = {
    baseRef: "main",
    branch: "feature",
    createdAt: new Date().toISOString(),
    kind: "worktree",
    mainWorktreePath: parent.path,
    managed: true,
    parentProjectId: parent.id,
    repoRoot: parent.path,
  };
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
        activeTerminalSessionIdByProject: {},
        browserLoading: {},
        browserTabsByProject: {},
        nextTerminalOrdinalByProject: {},
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
    ...createProjectLifecycleActions(store.setState, store.getState, {
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

test("removeWorktreeProject cleans up the worktree and activates the parent", async () => {
  const { calls, parent, parentChat, store, worktree, worktreeChat } =
    createTestStore({
      gitWorktreeCleanup: () => ({
        branch: "feature",
        branchDeleted: true,
        branchDeleteError: null,
        path: WORKTREE_PATH,
        pruned: false,
        removed: true,
      }),
    });

  const result = await store.getState().removeWorktreeProject({
    deleteBranch: true,
    mainWorktreePath: parent.path,
    parentProjectId: parent.id,
    worktreePath: worktree.path,
  });

  assert.equal(result?.branchDeleted, true);
  assert.deepEqual(calls, [
    {
      name: "gitWorktreeCleanup",
      request: {
        deleteBranch: true,
        force: false,
        projectPath: parent.path,
        worktreePath: worktree.path,
      },
    },
    {
      name: "checkpointDeleteProject",
      request: { projectPath: worktree.path },
    },
  ]);

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
  assert.equal(state.activeProjectId, parent.id);
  assert.equal(state.projectGitRefreshKeys[parent.id], 1);
});

test("removeWorktreeProject purges state when git no longer knows the worktree", async () => {
  const { parent, store, worktree } = createTestStore({
    gitWorktreeCleanup: () => {
      throw fakeApiError(
        "gitWorktreeCleanup",
        400,
        "Worktree was not found for this repository.",
      );
    },
  });

  const result = await store.getState().removeWorktreeProject({
    mainWorktreePath: parent.path,
    parentProjectId: parent.id,
    worktreePath: worktree.path,
  });

  assert.equal(result, null);
  const state = store.getState();
  assert.equal(hasProjectPath(state, WORKTREE_PATH), false);
  assert.equal(state.activeProjectId, parent.id);
});

test("removeWorktreeProject rethrows other failures without touching state", async () => {
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
    store.getState().removeWorktreeProject({
      mainWorktreePath: parent.path,
      parentProjectId: parent.id,
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
  assert.equal(
    state.projects.find((project) => project.id === created.projectId)?.worktree
      ?.branch,
    "background",
  );
  store.getState().setActiveProjectId(created.projectId);
  assert.equal(store.getState().activeProjectId, created.projectId);

  // The default still switches to the new worktree.
  const foreground = await store
    .getState()
    .createWorktreeProject(parent.id, { branchName: "feature-two" });
  assert.equal(store.getState().activeProjectId, foreground?.projectId);
});

const listedWorktreeInfo = (parentProjectId: string, repoRoot: string) => ({
  baseRef: null,
  branch: "listed",
  createdAt: new Date().toISOString(),
  kind: "worktree" as const,
  mainWorktreePath: repoRoot,
  managed: true,
  parentProjectId,
  repoRoot,
});

test("addProject marks a newly opened project as a worktree", () => {
  const { parent, store } = createTestStore();
  const listedPath = "/workspace/worktrees/source-listed";

  store.getState().addProject(listedPath, {
    worktree: listedWorktreeInfo(parent.id, parent.path),
  });

  const opened = store
    .getState()
    .projects.find((project) => project.path === listedPath);
  assert.equal(opened?.worktree?.branch, "listed");
  assert.equal(opened?.worktree?.parentProjectId, parent.id);
  assert.equal(store.getState().activeProjectId, opened?.id);
});

test("addProject fills in worktree info on an open project that lacks it", () => {
  const { parent, store } = createTestStore();
  const listedPath = "/workspace/worktrees/source-listed";
  store.getState().addProject(listedPath);
  assert.equal(
    store.getState().projects.find((project) => project.path === listedPath)
      ?.worktree,
    null,
  );

  store.getState().addProject(listedPath, {
    worktree: listedWorktreeInfo(parent.id, parent.path),
  });

  assert.equal(
    store.getState().projects.find((project) => project.path === listedPath)
      ?.worktree?.branch,
    "listed",
  );
});

test("addProject keeps the worktree info recorded at creation", () => {
  const { parent, store, worktree } = createTestStore();

  store.getState().addProject(WORKTREE_PATH, {
    worktree: listedWorktreeInfo(parent.id, parent.path),
  });

  const opened = store
    .getState()
    .projects.find((project) => project.id === worktree.id);
  assert.equal(opened?.worktree?.branch, "feature");
  assert.equal(opened?.worktree?.baseRef, "main");
});
