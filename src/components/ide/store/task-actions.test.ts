import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createProjectConfig,
  DEFAULT_SETTINGS,
  getDefaultModelSelection,
} from "@/lib/ide-defaults";
import { createDefaultTaskConfig } from "@/lib/task-defaults";
import type { ProjectConfig, Task } from "@/types/ide";
import { useActivityStore } from "../activity-store";
import { createChatActions } from "./chat-actions";
import type { IdeState } from "./ide-store-types";
import { createPanelActions } from "./panel-actions";
import { createRuntimeActions } from "./runtime-actions";
import { createStashActions } from "./stash-actions";
import {
  createTaskActions,
  finishTaskRunInProjects,
  getCurrentTaskRun,
  getTaskProjects,
  resolveTaskStepAgent,
  selectTaskEntries,
} from "./task-actions";

interface WorktreeRequest {
  activate?: boolean;
  branchName: string;
}

const createTestStore = () => {
  const worktreeRequests: WorktreeRequest[] = [];
  const harness = { failWorktree: null as string | null };
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const worktree = createProjectConfig("/workspace/worktree", DEFAULT_SETTINGS);
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: project.id,
        appView: "code",
        awaitingAnswerChatIds: {},
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        completedChatIds: {},
        draftChatIdByProject: {},
        messagesByChatId: {},
        pendingChatSubmitByChatId: {},
        tasksProjectId: null,
        projects: [project, worktree],
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        taskConfig: createDefaultTaskConfig(),
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createChatActions(store.setState, store.getState),
    ...createPanelActions(store.setState),
    ...createRuntimeActions(store.setState, store.getState),
    ...createTaskActions(store.setState, store.getState),
    ...createStashActions(store.setState, store.getState),
    // Stand-ins for slices these tests do not need in full. The real
    // `createWorktreeProject` shells out to git through the API server.
    createWorktreeProject: async (
      parentProjectId: string,
      options: WorktreeRequest,
    ) => {
      worktreeRequests.push(options);
      if (harness.failWorktree) {
        throw new Error(harness.failWorktree);
      }

      const created = {
        ...createProjectConfig(
          `/workspace/${options.branchName}`,
          DEFAULT_SETTINGS,
        ),
        worktree: {
          baseRef: "main",
          branch: options.branchName,
          createdAt: new Date().toISOString(),
          kind: "worktree" as const,
          mainWorktreePath: "/workspace/source",
          managed: true,
          parentProjectId,
          repoRoot: "/workspace/source",
        },
      };
      store.setState({ projects: [...store.getState().projects, created] });
      return { chatId: null, projectId: created.id };
    },
    addProject: (path: string) => {
      const closed = store
        .getState()
        .closedProjects.find((entry) => entry.path === path);
      if (closed) {
        store.setState({
          closedProjects: store
            .getState()
            .closedProjects.filter((entry) => entry.id !== closed.id),
          projects: [...store.getState().projects, closed],
        });
      }
    },
    setActiveProjectId: (id: string | null) =>
      store.setState({ activeProjectId: id }),
    loadMessagesForChat: async (chatId: string) =>
      store.getState().messagesByChatId[chatId] ?? [],
  } as Partial<IdeState>);

  return { harness, project, store, worktree, worktreeRequests };
};

type TestStore = ReturnType<typeof createTestStore>["store"];

const getTasks = (store: TestStore): Task[] =>
  store.getState().projects[0]?.ui.tasks ?? [];

const getTask = (store: TestStore): Task => {
  const task = getTasks(store)[0];
  assert.ok(task);
  return task;
};

const assistantMessage = (text: string): UIMessage =>
  ({
    id: crypto.randomUUID(),
    parts: [{ text, type: "text" }],
    role: "assistant",
  }) as UIMessage;

/** Simulates the chat panel running the queued prompt to a normal finish. */
const finishTurn = (store: TestStore, chatId: string, output: string) => {
  store.getState().takePendingChatSubmit(chatId);
  store.getState().setChatStreaming(chatId, true);
  store.setState({
    messagesByChatId: {
      ...store.getState().messagesByChatId,
      [chatId]: [assistantMessage(output)],
    },
  });
  useActivityStore.getState().finish(chatId, "finished", "");
  store.getState().setChatStreaming(chatId, false);
};

const flushMicrotasks = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

const addTask = (store: TestStore, projectId: string) => {
  const taskId = store.getState().addTask(projectId, {
    description: "Do the thing",
    title: "Task",
  });
  assert.ok(taskId);
  return taskId;
};

test("adds, updates, and deletes tasks", () => {
  const { project, store } = createTestStore();

  assert.equal(store.getState().addTask(project.id, { title: "   " }), null);

  const taskId = store.getState().addTask(project.id, {
    description: "  Details  ",
    title: "  Ship it  ",
  });
  assert.ok(taskId);

  const created = getTask(store);
  assert.equal(created.title, "Ship it");
  assert.equal(created.description, "Details");
  assert.equal(created.step, "backlog");
  assert.deepEqual(created.runs, []);

  store.getState().updateTask(project.id, taskId, { title: "Renamed" });
  assert.equal(getTask(store).id, taskId);
  assert.equal(getTask(store).title, "Renamed");
  assert.equal(getTask(store).description, "Details");

  store.getState().deleteTask(project.id, taskId);
  assert.equal(getTasks(store).length, 0);
});

test("backlog tasks reorder without disturbing other steps", async () => {
  const { project, store } = createTestStore();
  const ids = ["A", "B", "C"].map((title) => {
    const id = store.getState().addTask(project.id, { title });
    assert.ok(id);
    return id;
  });
  await store.getState().startTask(project.id, ids[1] as string);

  store.getState().moveTaskInBacklog(project.id, ids[2] as string, 0);
  assert.deepEqual(
    getTasks(store)
      .filter((task) => task.step === "backlog")
      .map((task) => task.title),
    ["C", "A"],
  );

  // Only backlog tasks can be reordered.
  store.getState().moveTaskInBacklog(project.id, ids[1] as string, 0);
  assert.equal(
    getTasks(store).find((task) => task.id === ids[1])?.step,
    "plan",
  );
});

test("starting a task runs the plan step in its own configured chat", async () => {
  const { project, store, worktreeRequests } = createTestStore();
  const taskId = addTask(store, project.id);

  const chatId = await store.getState().startTask(project.id, taskId);
  assert.ok(chatId);

  const state = store.getState();
  const chat = state.chats.find((entry) => entry.id === chatId);
  assert.equal(chat?.title, "Plan: Task");
  assert.equal(chat?.agentMode, "plan");
  assert.equal(chat?.permissionMode, "standard");

  // The task got its own background worktree and the chat runs there.
  assert.equal(worktreeRequests.length, 1);
  assert.equal(worktreeRequests[0]?.activate, false);
  assert.match(worktreeRequests[0]?.branchName ?? "", /^task\/task-[a-z0-9]+$/);
  const startedTask = getTask(store);
  assert.ok(startedTask.worktreeProjectId);
  assert.equal(chat?.projectId, startedTask.worktreeProjectId);
  assert.equal(startedTask.branch, worktreeRequests[0]?.branchName);
  assert.equal(startedTask.baseRef, "main");
  assert.equal(state.activeProjectId, project.id);

  const prompt = state.pendingChatSubmitByChatId[chatId]?.text ?? "";
  assert.match(prompt, /# Task/);
  assert.match(prompt, /Do the thing/);
  assert.doesNotMatch(prompt, /\{\{/);

  const task = getTask(store);
  assert.equal(task.step, "plan");
  assert.equal(task.runs.length, 1);
  assert.equal(task.runs[0]?.chatId, chatId);

  // Starting again is a no-op once the task left the backlog.
  assert.equal(await store.getState().startTask(project.id, taskId), null);
  assert.equal(store.getState().chats.length, 1);
});

test("a finished plan waits for approval, then hands its output to build", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const planChatId = await store.getState().startTask(project.id, taskId);
  assert.ok(planChatId);

  finishTurn(store, planChatId, "1. Edit foo.ts");
  await flushMicrotasks();

  // Plan is gated: the run is finished but the task stays put.
  assert.equal(getTask(store).step, "plan");
  assert.equal(getTask(store).runs[0]?.output, "1. Edit foo.ts");
  assert.ok(getTask(store).runs[0]?.finishedAt);

  const buildChatId = await store.getState().advanceTask(project.id, taskId);
  assert.ok(buildChatId);
  assert.notEqual(buildChatId, planChatId);

  const state = store.getState();
  const buildChat = state.chats.find((entry) => entry.id === buildChatId);
  assert.equal(buildChat?.agentMode, "build");
  assert.equal(buildChat?.permissionMode, "full-access");
  assert.match(
    state.pendingChatSubmitByChatId[buildChatId]?.text ?? "",
    /1\. Edit foo\.ts/,
  );
  assert.equal(getTask(store).step, "build");
});

test("build auto-advances to review when the agent finishes normally", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const planChatId = await store.getState().startTask(project.id, taskId);
  assert.ok(planChatId);
  finishTurn(store, planChatId, "The plan");
  const buildChatId = await store.getState().advanceTask(project.id, taskId);
  assert.ok(buildChatId);

  finishTurn(store, buildChatId, "Built it");
  await flushMicrotasks();

  const task = getTask(store);
  assert.equal(task.step, "review");
  const reviewRun = getCurrentTaskRun(task);
  assert.ok(reviewRun?.chatId);
  const prompt =
    store.getState().pendingChatSubmitByChatId[reviewRun.chatId]?.text ?? "";
  assert.match(prompt, /Built it/);
  assert.match(prompt, /The plan/);
});

const runToReview = async (
  store: ReturnType<typeof createTestStore>["store"],
  projectId: string,
  taskId: string,
) => {
  store.getState().setTaskStepConfig("review", (current) => ({
    ...current,
    autoAdvance: true,
  }));
  const planChatId = await store.getState().startTask(projectId, taskId);
  assert.ok(planChatId);
  finishTurn(store, planChatId, "The plan");
  const buildChatId = await store.getState().advanceTask(projectId, taskId);
  assert.ok(buildChatId);
  finishTurn(store, buildChatId, "Built it");
  await flushMicrotasks();
  const reviewChatId = getCurrentTaskRun(getTask(store))?.chatId;
  assert.ok(reviewChatId);
  return reviewChatId;
};

test("an auto-advancing review holds the task when changes are requested", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const reviewChatId = await runToReview(store, project.id, taskId);

  finishTurn(store, reviewChatId, "CHANGES REQUESTED\n1. Bug at foo.ts:3");
  await flushMicrotasks();

  assert.equal(getTask(store).step, "review");
});

test("an auto-advancing review moves on only with an explicit APPROVE", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const reviewChatId = await runToReview(store, project.id, taskId);

  finishTurn(store, reviewChatId, "APPROVE\n1. Nit at foo.ts:3");
  await flushMicrotasks();

  assert.equal(getTask(store).step, "merge");
});

test("waiting, failed, and interrupted turns never advance a task", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const planChatId = await store.getState().startTask(project.id, taskId);
  assert.ok(planChatId);
  finishTurn(store, planChatId, "The plan");
  const buildChatId = await store.getState().advanceTask(project.id, taskId);
  assert.ok(buildChatId);
  store.getState().takePendingChatSubmit(buildChatId);

  store.getState().setChatStreaming(buildChatId, true);
  useActivityStore.getState().attention(buildChatId, "Which option?");
  store.getState().setChatStreaming(buildChatId, false);
  await flushMicrotasks();
  assert.equal(getTask(store).step, "build");

  store.getState().setChatStreaming(buildChatId, true);
  useActivityStore.getState().finish(buildChatId, "failed", "boom");
  store.getState().setChatStreaming(buildChatId, false);
  await flushMicrotasks();
  assert.equal(getTask(store).step, "build");
  assert.equal(getCurrentTaskRun(getTask(store))?.finishedAt, null);

  // A busy step cannot be approved either.
  store.getState().setChatStreaming(buildChatId, true);
  assert.equal(await store.getState().advanceTask(project.id, taskId), null);
});

test("sending a task back reuses the step chat and carries the findings", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const planChatId = await store.getState().startTask(project.id, taskId);
  assert.ok(planChatId);
  finishTurn(store, planChatId, "The plan");
  const buildChatId = await store.getState().advanceTask(project.id, taskId);
  assert.ok(buildChatId);
  finishTurn(store, buildChatId, "Built it");
  await flushMicrotasks();

  const reviewChatId = getCurrentTaskRun(getTask(store))?.chatId;
  assert.ok(reviewChatId);
  finishTurn(store, reviewChatId, "CHANGES REQUESTED\n1. foo.ts:3 is wrong");
  await flushMicrotasks();
  assert.equal(getTask(store).step, "review");

  // Tasks only move backwards through send-back.
  assert.equal(
    await store.getState().sendTaskBack(project.id, taskId, "merge"),
    null,
  );

  const chatId = await store
    .getState()
    .sendTaskBack(project.id, taskId, "build", "Also add a test");
  assert.equal(chatId, buildChatId);

  const task = getTask(store);
  assert.equal(task.step, "build");
  assert.equal(task.runs.length, 4);
  const prompt =
    store.getState().pendingChatSubmitByChatId[buildChatId]?.text ?? "";
  assert.match(prompt, /sent back from the review step/);
  assert.match(prompt, /foo\.ts:3 is wrong/);
  assert.match(prompt, /Also add a test/);
  assert.equal(store.getState().chats.length, 3);
});

test("retrying a step starts a fresh chat with the same handoff", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const planChatId = await store.getState().startTask(project.id, taskId);
  assert.ok(planChatId);
  finishTurn(store, planChatId, "The plan");
  const buildChatId = await store.getState().advanceTask(project.id, taskId);
  assert.ok(buildChatId);
  store.getState().takePendingChatSubmit(buildChatId);

  const retryChatId = await store.getState().retryTaskStep(project.id, taskId);
  assert.ok(retryChatId);
  assert.notEqual(retryChatId, buildChatId);
  assert.equal(getTask(store).step, "build");
  assert.match(
    store.getState().pendingChatSubmitByChatId[retryChatId]?.text ?? "",
    /The plan/,
  );
});

test("step chats run in the task's worktree project without stealing focus", async () => {
  const { project, store, worktree } = createTestStore();
  const taskId = addTask(store, project.id);
  store.setState({
    projects: store.getState().projects.map((entry) =>
      entry.id === project.id
        ? {
            ...entry,
            ui: {
              ...entry.ui,
              tasks: entry.ui.tasks.map((task) => ({
                ...task,
                branch: "task/task",
                worktreeProjectId: worktree.id,
              })),
            },
          }
        : entry,
    ),
  });

  const chatId = await store.getState().startTask(project.id, taskId);
  assert.ok(chatId);

  const state = store.getState();
  assert.equal(
    state.chats.find((entry) => entry.id === chatId)?.projectId,
    worktree.id,
  );
  assert.equal(state.activeProjectId, project.id);
  assert.equal(state.isTaskChat(chatId), true);

  // The task lives in the parent project while its chat finishes elsewhere.
  finishTurn(store, chatId, "Worktree plan");
  assert.equal(getTask(store).runs[0]?.output, "Worktree plan");

  // Opening the chat leaves the app-level Tasks workspace for the chat's project.
  store.getState().setAppView("tasks");
  store.getState().openTaskStepChat(project.id, taskId);
  assert.equal(store.getState().appView, "code");
  assert.equal(store.getState().activeProjectId, worktree.id);
  assert.equal(
    store.getState().projects.find((entry) => entry.id === worktree.id)?.ui
      .activeChatId,
    chatId,
  );
});

test("a failed worktree leaves the task in the backlog and reports why", async () => {
  const { harness, project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  harness.failWorktree = "not a git repository";

  await assert.rejects(
    store.getState().startTask(project.id, taskId),
    /not a git repository/,
  );
  assert.equal(getTask(store).step, "backlog");
  assert.equal(getTask(store).worktreeProjectId, null);
  assert.equal(store.getState().chats.length, 0);
});

test("tasks in a worktree project run in place instead of nesting", async () => {
  const { project, store, worktreeRequests } = createTestStore();
  store.setState({
    projects: store.getState().projects.map((entry) =>
      entry.id === project.id
        ? {
            ...entry,
            worktree: {
              baseRef: "main",
              branch: "feature",
              createdAt: new Date().toISOString(),
              kind: "worktree" as const,
              mainWorktreePath: "/workspace/main",
              managed: true,
              parentProjectId: null,
              repoRoot: "/workspace/main",
            },
          }
        : entry,
    ),
  });
  const taskId = addTask(store, project.id);

  const chatId = await store.getState().startTask(project.id, taskId);
  assert.ok(chatId);
  assert.equal(worktreeRequests.length, 0);
  assert.equal(
    store.getState().chats.find((entry) => entry.id === chatId)?.projectId,
    project.id,
  );
});

test("a closed worktree project reopens in the background", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const planChatId = await store.getState().startTask(project.id, taskId);
  assert.ok(planChatId);
  // The chat panel consumed the queued prompt before the project was closed.
  store.getState().takePendingChatSubmit(planChatId);
  const worktreeProjectId = getTask(store).worktreeProjectId;
  assert.ok(worktreeProjectId);

  const worktreeProject = store
    .getState()
    .projects.find((entry) => entry.id === worktreeProjectId);
  assert.ok(worktreeProject);
  store.setState({
    closedProjects: [worktreeProject],
    projects: store
      .getState()
      .projects.filter((entry) => entry.id !== worktreeProjectId),
  });
  assert.equal(await store.getState().retryTaskStep(project.id, taskId), null);

  assert.equal(
    await store.getState().reopenTaskWorktree(project.id, taskId),
    true,
  );
  assert.ok(await store.getState().retryTaskStep(project.id, taskId));

  // A worktree removed outside the Tasks workspace cannot be reopened.
  store.setState({
    closedProjects: [],
    projects: store
      .getState()
      .projects.filter((entry) => entry.id !== worktreeProjectId),
  });
  assert.equal(
    await store.getState().reopenTaskWorktree(project.id, taskId),
    false,
  );
});

test("a task whose worktree project is closed cannot run steps", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  store.setState({
    projects: store.getState().projects.map((entry) =>
      entry.id === project.id
        ? {
            ...entry,
            ui: {
              ...entry.ui,
              tasks: entry.ui.tasks.map((task) => ({
                ...task,
                worktreeProjectId: "closed-project",
              })),
            },
          }
        : entry,
    ),
  });

  assert.equal(await store.getState().startTask(project.id, taskId), null);
  assert.equal(getTask(store).step, "backlog");
});

test("deleting a step chat unlinks the run but keeps its output", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  const chatId = await store.getState().startTask(project.id, taskId);
  assert.ok(chatId);
  finishTurn(store, chatId, "The plan");

  store.getState().deleteChat(chatId);
  const run = getTask(store).runs[0];
  assert.equal(run?.chatId, null);
  assert.equal(run?.output, "The plan");
  assert.equal(getTask(store).step, "plan");
});

test("completing a task records how it finished", async () => {
  const { project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  await store.getState().startTask(project.id, taskId);

  store.getState().completeTask(project.id, taskId, {
    at: "2026-09-18T00:00:00.000Z",
    kind: "pr",
    mergeCommit: null,
    prUrl: "https://example.com/pr/1",
  });
  assert.equal(getTask(store).step, "merge");
  assert.equal(getTask(store).completion?.kind, "pr");
  assert.equal(await store.getState().retryTaskStep(project.id, taskId), null);
});

test("step config is one app-wide setting", () => {
  const { store } = createTestStore();
  const projectsBefore = store.getState().projects;

  store.getState().setTaskStepConfig("plan", (config) => ({
    ...config,
    autoAdvance: true,
    prompt: "Custom {{task.title}}",
  }));
  const config = store.getState().taskConfig;
  assert.equal(config.plan.autoAdvance, true);
  assert.equal(config.plan.prompt, "Custom {{task.title}}");
  // Other steps are untouched, and nothing is written onto any project.
  assert.equal(config.build.prompt, null);
  assert.equal(store.getState().projects, projectsBefore);
  assert.equal("taskConfig" in (store.getState().projects[0]?.ui ?? {}), false);

  // Clearing the prompt returns the step to the built-in template.
  store.getState().setTaskStepConfig("plan", (config) => ({
    ...config,
    prompt: null,
  }));
  assert.equal(store.getState().taskConfig.plan.prompt, null);
  assert.equal(store.getState().taskConfig.plan.autoAdvance, true);
});

test("every project's tasks run with the same app-wide step config", async () => {
  const { project, store, worktree: other } = createTestStore();
  store.getState().setTaskStepConfig("plan", (config) => ({
    ...config,
    permissionMode: "full-access",
    prompt: "Shared plan for {{task.title}}",
  }));

  for (const owner of [project, other]) {
    const taskId = addTask(store, owner.id);
    const chatId = await store.getState().startTask(owner.id, taskId);
    assert.ok(chatId);
    const chat = store.getState().chats.find((entry) => entry.id === chatId);
    assert.equal(chat?.permissionMode, "full-access");
    assert.match(
      store.getState().pendingChatSubmitByChatId[chatId]?.text ?? "",
      /^Shared plan for Task/,
    );
  }
});

test("resolveTaskStepAgent prefers the step model over defaults", () => {
  const { project } = createTestStore();
  const model = {
    model: "opus",
    modelSpeed: "standard",
    provider: "anthropic",
    reasoningEffort: "high",
  } as const;

  assert.deepEqual(
    resolveTaskStepAgent({ model }, project, DEFAULT_SETTINGS),
    model,
  );

  const inherited = resolveTaskStepAgent(
    { model: null },
    project,
    DEFAULT_SETTINGS,
  );
  // With no app-wide default model, the host project's selection is used.
  assert.deepEqual(inherited, {
    model: project.model,
    modelSpeed: project.modelSpeed,
    provider: project.provider,
    reasoningEffort: project.reasoningEffort,
  });

  const settings = { ...DEFAULT_SETTINGS, defaultModel: "sonnet" };
  assert.equal(
    resolveTaskStepAgent({ model: null }, project, settings).model,
    getDefaultModelSelection(settings).model,
  );
});

test("finishTaskRunInProjects returns the same reference when nothing changes", () => {
  const { project } = createTestStore();
  const projects = [project];
  assert.equal(
    finishTaskRunInProjects(projects, "unknown", "", "now"),
    projects,
  );
});

const asWorktree = (project: ProjectConfig): ProjectConfig => ({
  ...project,
  worktree: {
    baseRef: "main",
    branch: "task/task",
    createdAt: new Date().toISOString(),
    kind: "worktree",
    mainWorktreePath: "/workspace/source",
    managed: true,
    parentProjectId: null,
    repoRoot: "/workspace/source",
  },
});

test("selects task entries for one project or all of them", () => {
  const { project, store, worktree: other } = createTestStore();
  const first = addTask(store, project.id);
  const second = addTask(store, project.id);
  const third = addTask(store, other.id);
  const { projects } = store.getState();

  const scoped = selectTaskEntries(projects, other.id);
  assert.equal(scoped.scopeProject?.id, other.id);
  assert.deepEqual(
    scoped.entries.map((entry) => [entry.projectId, entry.task.id]),
    [[other.id, third]],
  );

  // Across projects, each project's tasks stay together and in their order.
  const all = selectTaskEntries(projects, null);
  assert.equal(all.scopeProject, null);
  assert.deepEqual(
    all.entries.map((entry) => [entry.projectId, entry.task.id]),
    [
      [project.id, first],
      [project.id, second],
      [other.id, third],
    ],
  );
  assert.equal(all.entries[0]?.project, projects[0]);
  assert.equal(all.entries[0]?.key, `${project.id}:${first}`);
  assert.equal(new Set(all.entries.map((entry) => entry.key)).size, 3);
});

test("the Tasks workspace's project filter ignores the active project", () => {
  const { project, store, worktree: other } = createTestStore();
  addTask(store, project.id);
  const otherTask = addTask(store, other.id);
  store.getState().setTasksProjectId(other.id);

  // Switching Code's project tab must not move the Tasks workspace.
  for (const activeProjectId of [project.id, other.id, null]) {
    store.setState({ activeProjectId });
    const { tasksProjectId, projects } = store.getState();
    assert.deepEqual(
      selectTaskEntries(projects, tasksProjectId).entries.map(
        (entry) => entry.task.id,
      ),
      [otherTask],
    );
  }
  assert.equal(store.getState().activeProjectId, null);
});

test("a filter pointing at a project that is no longer open shows everything", () => {
  const { project, store, worktree: other } = createTestStore();
  addTask(store, project.id);
  addTask(store, other.id);

  const selection = selectTaskEntries(
    store.getState().projects,
    "closed-project",
  );
  assert.equal(selection.scopeProject, null);
  assert.equal(selection.entries.length, 2);
});

test("the project filter lists worktrees only when they hold tasks", () => {
  const { project, store, worktree } = createTestStore();
  addTask(store, project.id);
  const withWorktree = () =>
    store
      .getState()
      .projects.map((entry) =>
        entry.id === worktree.id ? asWorktree(entry) : entry,
      );

  assert.deepEqual(
    getTaskProjects(withWorktree()).map((entry) => entry.id),
    [project.id],
  );

  addTask(store, worktree.id);
  assert.deepEqual(
    getTaskProjects(withWorktree()).map((entry) => entry.id),
    [project.id, worktree.id],
  );
});
