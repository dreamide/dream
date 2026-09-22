import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test, vi } from "vitest";
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
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createRuntimeActions } from "./runtime-actions";
import { createStashActions } from "./stash-actions";
import {
  createTaskActions,
  finishTaskRun,
  getCurrentTaskRun,
  getRecentTaskProjects,
  getTaskProjects,
  getTaskScopeProjects,
  resolveTaskStepAgent,
  selectTaskEntries,
  summarizeCommitError,
} from "./task-actions";

interface WorktreeRequest {
  activate?: boolean;
  branchName: string;
}

interface WorktreeApiRequest {
  action: "check" | "recreate";
  branch: string;
  projectPath: string;
  worktreePath: string;
}

interface CommitRequest {
  model?: string;
  provider?: string;
  fallbackMessage: string;
  projectPath: string;
}

const createTestStore = () => {
  const worktreeRequests: WorktreeRequest[] = [];
  const commitRequests: CommitRequest[] = [];
  const worktreeRequests2: WorktreeApiRequest[] = [];
  const harness = {
    /** Git's output when the app's commit should be rejected. */
    failCommit: null as string | null,
    failWorktree: null as string | null,
    /** Whether the task's branch still exists in the repository. */
    branchExists: true,
    /** Whether the task's worktree folder is still a git checkout. */
    worktreeOnDisk: true,
  };
  // The app commits a step's work through the API server.
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (url === "/api/project-git-task-worktree") {
      const request = body as WorktreeApiRequest;
      worktreeRequests2.push(request);
      if (request.action === "recreate") {
        harness.worktreeOnDisk = true;
      }
      return {
        json: async () =>
          request.action === "recreate"
            ? {
                branch: request.branch,
                mainWorktreePath: "/workspace/source",
                path: request.worktreePath,
                repoRoot: "/workspace/source",
              }
            : {
                branchExists: harness.branchExists,
                isCheckout: harness.worktreeOnDisk,
              },
        ok: true,
        status: 200,
        text: async () => "",
      };
    }

    assert.equal(url, "/api/project-git-task-commit");
    commitRequests.push(body as CommitRequest);
    if (!harness.worktreeOnDisk) {
      return {
        json: async () => ({}),
        ok: false,
        status: 410,
        text: async () => "This task's worktree is no longer a git checkout",
      };
    }
    const rejection = harness.failCommit;
    return {
      json: async () => ({ committed: true }),
      ok: rejection === null,
      status: rejection === null ? 200 : 400,
      text: async () => rejection ?? "",
    };
  });
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
        missingTaskWorktrees: {},
        pendingChatSubmitByChatId: {},
        projectGitRefreshKeys: {},
        tasks: [],
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

  return {
    commitRequests,
    worktreeApiRequests: worktreeRequests2,
    harness,
    project,
    store,
    worktree,
    worktreeRequests,
  };
};

type TestStore = ReturnType<typeof createTestStore>["store"];

/** The source project's tasks, in app-wide order. */
const getTasks = (store: TestStore): Task[] => {
  const { projects, tasks } = store.getState();
  return tasks.filter((task) => task.projectId === projects[0]?.id);
};

const getTaskById = (store: TestStore, taskId: string): Task | undefined =>
  store.getState().tasks.find((task) => task.id === taskId);

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
  for (let index = 0; index < 50; index += 1) {
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
  assert.equal(chat?.permissionMode, "full-access");

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

  // The second build run shares the first one's chat. Finishing it must
  // complete *that* run and auto-advance again, not match the older run.
  finishTurn(store, buildChatId, "Fixed foo.ts and added a test");
  await flushMicrotasks();
  const advanced = getTask(store);
  const secondBuild = advanced.runs[3];
  assert.equal(secondBuild?.step, "build");
  assert.ok(secondBuild?.finishedAt);
  assert.equal(secondBuild?.output, "Fixed foo.ts and added a test");
  assert.equal(advanced.runs[1]?.output, "Built it");
  assert.equal(advanced.step, "review");
  assert.equal(advanced.runs.length, 5);
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
    tasks: store.getState().tasks.map((task) => ({
      ...task,
      branch: "task/task",
      worktreeProjectId: worktree.id,
    })),
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
    tasks: store.getState().tasks.map((task) => ({
      ...task,
      worktreeProjectId: "closed-project",
    })),
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

test("finishTaskRun returns the same reference when nothing changes", () => {
  const { project, store } = createTestStore();
  addTask(store, project.id);
  const { tasks } = store.getState();
  assert.equal(finishTaskRun(tasks, "unknown", "", "now"), tasks);
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
  const { projects, tasks } = store.getState();
  const lists = { closedProjects: [], projects };

  const scoped = selectTaskEntries(lists, tasks, other.id);
  assert.equal(scoped.scopeProject?.id, other.id);
  assert.deepEqual(
    scoped.entries.map((entry) => [entry.projectId, entry.task.id]),
    [[other.id, third]],
  );

  // Across projects, each project's tasks stay together and in their order.
  const all = selectTaskEntries(lists, tasks, null);
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
  // Task ids are unique across the app, so they key the cards.
  assert.equal(all.entries[0]?.key, first);
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
    const { closedProjects, projects, tasks, tasksProjectId } =
      store.getState();
    assert.deepEqual(
      selectTaskEntries(
        { closedProjects, projects },
        tasks,
        tasksProjectId,
      ).entries.map((entry) => entry.task.id),
      [otherTask],
    );
  }
  assert.equal(store.getState().activeProjectId, null);
});

test("a filter pointing at a project that no longer exists shows everything", () => {
  const { project, store, worktree: other } = createTestStore();
  addTask(store, project.id);
  addTask(store, other.id);

  const selection = selectTaskEntries(
    { closedProjects: [], projects: store.getState().projects },
    store.getState().tasks,
    "removed-project",
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
    getTaskProjects(withWorktree(), store.getState().tasks).map(
      (entry) => entry.id,
    ),
    [project.id],
  );

  addTask(store, worktree.id);
  assert.deepEqual(
    getTaskProjects(withWorktree(), store.getState().tasks).map(
      (entry) => entry.id,
    ),
    [project.id, worktree.id],
  );
});

/** Uses the real `addProject`, which is what reopens and registers projects. */
const createTestStoreWithRealProjects = () => {
  const context = createTestStore();
  context.store.setState({
    addProject: createProjectLifecycleActions(
      context.store.setState,
      context.store.getState,
    ).addProject,
  });
  return context;
};

test("a task can be filed under a recent project without leaving Tasks", () => {
  const { project, store } = createTestStoreWithRealProjects();
  const recent = createProjectConfig("/workspace/recent", DEFAULT_SETTINGS);
  store.setState({
    appView: "tasks",
    closedProjects: [recent],
  });

  const taskId = store
    .getState()
    .addTaskToProjectPath(recent.path, { title: "From Tasks" });
  assert.ok(taskId);

  const state = store.getState();
  // The task belongs to the project without the project being loaded...
  assert.deepEqual(
    state.tasks.map((task) => [task.id, task.projectId]),
    [[taskId, recent.id]],
  );
  assert.deepEqual(
    state.closedProjects.map((entry) => entry.id),
    [recent.id],
  );
  // ...and neither the workspace nor Code's active tab moved.
  assert.equal(state.appView, "tasks");
  assert.equal(state.activeProjectId, project.id);
});

test("a task can be filed under a folder the app has never seen", () => {
  const { project, store } = createTestStoreWithRealProjects();
  const openBefore = store.getState().projects.length;

  const taskId = store
    .getState()
    .addTaskToProjectPath("/workspace/brand-new", { title: "New repo" });
  assert.ok(taskId);

  const state = store.getState();
  assert.equal(state.projects.length, openBefore + 1);
  const created = state.projects.find(
    (entry) => entry.path === "/workspace/brand-new",
  );
  assert.equal(created?.name, "brand-new");
  assert.deepEqual(
    state.tasks.map((task) => [task.id, task.projectId]),
    [[taskId, created?.id]],
  );
  assert.equal(state.activeProjectId, project.id);
});

test("filing under an already open project reuses it", () => {
  const { project, store } = createTestStoreWithRealProjects();
  const openBefore = store.getState().projects.length;

  // Same folder, different spelling: no duplicate project is created.
  const taskId = store
    .getState()
    .addTaskToProjectPath(`${project.path}/`, { title: "Again" });
  assert.ok(taskId);
  assert.equal(store.getState().projects.length, openBefore);
  assert.deepEqual(
    getTasks(store).map((task) => task.id),
    [taskId],
  );

  assert.equal(
    store.getState().addTaskToProjectPath("  ", { title: "x" }),
    null,
  );
});

test("recent task projects are closed non-worktrees, newest first", () => {
  const closed = (path: string, lastUsedAt: string | null) => ({
    ...createProjectConfig(path, DEFAULT_SETTINGS),
    lastUsedAt,
  });
  const older = closed("/workspace/older", "2026-01-01T00:00:00.000Z");
  const newer = closed("/workspace/newer", "2026-06-01T00:00:00.000Z");
  const never = closed("/workspace/never", null);
  const worktree = asWorktree(
    closed("/workspace/worktree-closed", "2026-09-01T00:00:00.000Z"),
  );

  assert.deepEqual(
    getRecentTaskProjects([older, worktree, never, newer]).map(
      (entry) => entry.path,
    ),
    ["/workspace/newer", "/workspace/older", "/workspace/never"],
  );
});

/** Moves a project from Code's tabs to the recent list, as closing a tab does. */
const closeProjectInStore = (store: TestStore, projectId: string) => {
  const state = store.getState();
  const closing = state.projects.find((entry) => entry.id === projectId);
  assert.ok(closing);
  store.setState({
    activeProjectId:
      state.activeProjectId === projectId ? null : state.activeProjectId,
    closedProjects: [...state.closedProjects, closing],
    projects: state.projects.filter((entry) => entry.id !== projectId),
  });
};

test("closing a project in Code keeps its tasks on the board", () => {
  const { project, store, worktree: other } = createTestStore();
  const taskId = addTask(store, project.id);
  addTask(store, other.id);
  store.getState().setTasksProjectId(project.id);
  closeProjectInStore(store, project.id);

  const { closedProjects, projects, tasks, tasksProjectId } = store.getState();
  const selection = selectTaskEntries(
    { closedProjects, projects },
    tasks,
    tasksProjectId,
  );
  // The closed project stays the filter, and its task is still listed.
  assert.equal(selection.scopeProject?.id, project.id);
  assert.deepEqual(
    selection.entries.map((entry) => entry.task.id),
    [taskId],
  );
  // Open projects come first in the filter; closed ones only with tasks.
  assert.deepEqual(
    getTaskScopeProjects(projects, closedProjects, tasks).map(
      (entry) => entry.id,
    ),
    [other.id, project.id],
  );
  assert.deepEqual(
    getTaskScopeProjects(projects, closedProjects, []).map((entry) => entry.id),
    [other.id],
  );

  // Tasks of a closed project can still be edited, reordered and deleted.
  store.getState().updateTask(project.id, taskId, { title: "Renamed" });
  assert.equal(getTaskById(store, taskId)?.title, "Renamed");
  store.getState().deleteTask(project.id, taskId);
  assert.equal(getTaskById(store, taskId), undefined);
});

test("starting a task of a closed project loads it in the background", async () => {
  const { project, store, worktree: other } = createTestStore();
  const taskId = addTask(store, project.id);
  closeProjectInStore(store, project.id);
  store.setState({ activeProjectId: other.id, appView: "tasks" });

  const chatId = await store.getState().startTask(project.id, taskId);
  assert.ok(chatId);

  const state = store.getState();
  assert.ok(state.projects.some((entry) => entry.id === project.id));
  assert.equal(state.closedProjects.length, 0);
  assert.equal(getTaskById(store, taskId)?.step, "plan");
  // The user stays where they were.
  assert.equal(state.activeProjectId, other.id);
  assert.equal(state.appView, "tasks");
});

test("opening a step chat of a closed project reopens it in Code", async () => {
  const { project, store } = createTestStoreWithRealProjects();
  const taskId = addTask(store, project.id);
  // A task with runs stays in its own project (no worktree), like tasks
  // migrated from the old board.
  store.setState({
    tasks: store.getState().tasks.map((task) => ({
      ...task,
      runs: [
        {
          chatId: null,
          commitError: null,
          feedback: null,
          finishedAt: "2026-08-15T12:00:00.000Z",
          id: "run-old",
          output: "Earlier work",
          startedAt: "2026-08-15T12:00:00.000Z",
          step: "plan" as const,
        },
      ],
      step: "plan" as const,
    })),
  });
  const chatId = await store.getState().retryTaskStep(project.id, taskId);
  assert.ok(chatId);
  closeProjectInStore(store, project.id);
  store.setState({ appView: "tasks" });

  store.getState().openTaskStepChat(project.id, taskId);

  const state = store.getState();
  assert.equal(state.activeProjectId, project.id);
  assert.ok(state.projects.some((entry) => entry.id === project.id));
  assert.equal(state.appView, "code");
});

test("reordering one project's backlog leaves other projects' tasks in place", () => {
  const { project, store, worktree: other } = createTestStore();
  const first = addTask(store, project.id);
  const foreign = addTask(store, other.id);
  const second = addTask(store, project.id);

  store.getState().moveTaskInBacklog(project.id, second, 0);

  assert.deepEqual(
    store.getState().tasks.map((task) => task.id),
    [second, foreign, first],
  );
});

/** Runs a task to a finished build turn; `output` is the builder's summary. */
const runToFinishedBuild = async (
  store: TestStore,
  projectId: string,
  taskId: string,
) => {
  const planChatId = await store.getState().startTask(projectId, taskId);
  assert.ok(planChatId);
  finishTurn(store, planChatId, "The plan");
  const buildChatId = await store.getState().advanceTask(projectId, taskId);
  assert.ok(buildChatId);
  finishTurn(store, buildChatId, "Built it");
  await flushMicrotasks();
  return buildChatId;
};

test("the app commits a finished build in the task's worktree, then advances", async () => {
  const { commitRequests, project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  await runToFinishedBuild(store, project.id, taskId);

  const task = getTask(store);
  // Planning changes no files, so only the build was committed — once.
  assert.deepEqual(commitRequests, [
    {
      fallbackMessage: "Task",
      model: commitRequests[0]?.model,
      projectPath: task.worktreePath,
      provider: commitRequests[0]?.provider,
    },
  ]);
  assert.equal(task.step, "review");
  assert.equal(task.runs[1]?.commitError, null);
});

test("a build is committed even when it does not advance by itself", async () => {
  const { commitRequests, project, store } = createTestStore();
  store.getState().setTaskStepConfig("build", (config) => ({
    ...config,
    autoAdvance: false,
  }));
  const taskId = addTask(store, project.id);
  await runToFinishedBuild(store, project.id, taskId);

  assert.equal(commitRequests.length, 1);
  assert.equal(getTask(store).step, "build");

  // Approving commits again, which is a no-op for git, and moves on.
  assert.ok(await store.getState().advanceTask(project.id, taskId));
  assert.equal(commitRequests.length, 2);
  assert.equal(getTask(store).step, "review");
});

test("a rejected commit holds the task and goes back to the same agent", async () => {
  const { commitRequests, harness, project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  harness.failCommit = "pre-commit: lint failed in Slider.jsx";
  const buildChatId = await runToFinishedBuild(store, project.id, taskId);

  let task = getTask(store);
  assert.equal(task.step, "build");
  assert.equal(task.runs[1]?.commitError, harness.failCommit);
  assert.ok(task.runs[1]?.finishedAt);

  // Approving cannot skip the commit either.
  await assert.rejects(
    store.getState().advanceTask(project.id, taskId),
    /lint failed in Slider\.jsx/,
  );
  assert.equal(getTask(store).step, "build");

  // Retrying continues in the builder's chat, with git's output as feedback.
  const retryChatId = await store.getState().retryTaskStep(project.id, taskId);
  assert.equal(retryChatId, buildChatId);
  const prompt =
    store.getState().pendingChatSubmitByChatId[buildChatId]?.text ?? "";
  assert.match(prompt, /could not commit your work/);
  assert.match(prompt, /lint failed in Slider\.jsx/);

  harness.failCommit = null;
  finishTurn(store, buildChatId, "Fixed the lint error");
  await flushMicrotasks();

  task = getTask(store);
  assert.equal(task.step, "review");
  assert.equal(task.runs[2]?.step, "build");
  assert.equal(task.runs[2]?.commitError, null);
  assert.equal(commitRequests.at(-1)?.fallbackMessage, "Address review: Task");
});

test("tasks without their own worktree are never committed by the app", async () => {
  const { commitRequests, project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  // A task migrated from the old board runs in the user's own checkout, where
  // staging everything would sweep up their unrelated work.
  store.setState({
    tasks: store.getState().tasks.map((task) => ({
      ...task,
      runs: [
        {
          chatId: null,
          commitError: null,
          feedback: null,
          finishedAt: "2026-08-15T12:00:00.000Z",
          id: "run-plan",
          output: "The plan",
          startedAt: "2026-08-15T12:00:00.000Z",
          step: "plan" as const,
        },
      ],
      step: "plan" as const,
    })),
  });

  const buildChatId = await store.getState().advanceTask(project.id, taskId);
  assert.ok(buildChatId);
  finishTurn(store, buildChatId, "Built it");
  await flushMicrotasks();

  assert.equal(getTask(store).worktreeProjectId, null);
  assert.equal(getTask(store).step, "review");
  assert.deepEqual(commitRequests, []);
});

test("a rejected commit keeps git's reason and drops its usage text", () => {
  const dump = [
    "warning: Not a git repository. Use --no-index to compare two paths",
    "usage: git diff --no-index [<options>] <path> <path>",
    "",
    "Diff output format options",
    "    -p, --patch           generate patch",
  ].join("\n");
  assert.equal(
    summarizeCommitError(dump),
    "warning: Not a git repository. Use --no-index to compare two paths",
  );

  // Hook output is kept as it is, up to a sensible length.
  const hook = "pre-commit: lint failed\n  Slider.jsx:3 unused import";
  assert.equal(summarizeCommitError(hook), hook);
  const long = Array.from({ length: 80 }, (_, index) => `line ${index}`).join(
    "\n",
  );
  assert.equal(summarizeCommitError(long).split("\n").length, 20);
});

test("a missing worktree is not a rejected commit: nothing goes back to the agent", async () => {
  const { harness, project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  harness.worktreeOnDisk = false;
  await runToFinishedBuild(store, project.id, taskId);

  const task = getTask(store);
  assert.equal(task.step, "build");
  // The agent cannot fix a missing checkout, so no commit error is recorded
  // for a retry to hand back; the card offers to recreate the worktree.
  assert.equal(task.runs[1]?.commitError, null);
  assert.deepEqual(store.getState().missingTaskWorktrees, {
    [taskId]: { branchExists: true },
  });
  await assert.rejects(
    store.getState().advanceTask(project.id, taskId),
    /no longer a git checkout/,
  );
  assert.equal(getTask(store).step, "build");
});

test("reopening checks the disk first, and recreating brings the worktree back", async () => {
  const { harness, project, store, worktreeApiRequests } = createTestStore();
  const taskId = addTask(store, project.id);
  await runToFinishedBuild(store, project.id, taskId);
  const worktreeProjectId = getTask(store).worktreeProjectId;
  assert.ok(worktreeProjectId);
  closeProjectInStore(store, worktreeProjectId);

  harness.worktreeOnDisk = false;
  assert.equal(
    await store.getState().reopenTaskWorktree(project.id, taskId),
    false,
  );
  // Still closed: opening a project whose folder is gone helps nobody.
  assert.ok(
    store
      .getState()
      .closedProjects.some((entry) => entry.id === worktreeProjectId),
  );
  assert.deepEqual(store.getState().missingTaskWorktrees, {
    [taskId]: { branchExists: true },
  });

  await store.getState().recreateTaskWorktree(project.id, taskId);

  const task = getTask(store);
  assert.deepEqual(worktreeApiRequests.at(-1), {
    action: "recreate",
    branch: task.branch,
    projectPath: project.path,
    worktreePath: task.worktreePath,
  });
  // The same project record is reopened, so its step chats are still linked.
  assert.equal(task.worktreeProjectId, worktreeProjectId);
  assert.ok(
    store.getState().projects.some((entry) => entry.id === worktreeProjectId),
  );
  assert.deepEqual(store.getState().missingTaskWorktrees, {});
});

test("recreating a worktree the app has no record of registers it for the task", async () => {
  const { project, store } = createTestStoreWithRealProjects();
  const taskId = addTask(store, project.id);
  const openBefore = store.getState().projects.length;
  // The worktree project was purged (e.g. removed from Code), but the task
  // still names its branch and folder.
  store.setState({
    missingTaskWorktrees: { [taskId]: { branchExists: true } },
    tasks: store.getState().tasks.map((task) => ({
      ...task,
      baseRef: "main",
      branch: "task/task-abc123",
      step: "build" as const,
      worktreePath: "/workspace/worktrees/task-abc123",
      worktreeProjectId: "purged-project",
    })),
  });

  await store.getState().recreateTaskWorktree(project.id, taskId);

  const state = store.getState();
  const task = getTask(store);
  assert.equal(state.projects.length, openBefore + 1);
  const created = state.projects.find(
    (entry) => entry.id === task.worktreeProjectId,
  );
  assert.equal(created?.path, "/workspace/worktrees/task-abc123");
  assert.equal(created?.worktree?.branch, "task/task-abc123");
  assert.equal(created?.worktree?.parentProjectId, project.id);
  assert.equal(created?.worktree?.managed, true);
  assert.deepEqual(state.missingTaskWorktrees, {});
  // Code's active tab did not move.
  assert.equal(state.activeProjectId, project.id);
});

test("a closed worktree is checked on disk: gone with its branch means mark as done", async () => {
  const { harness, project, store } = createTestStore();
  const taskId = addTask(store, project.id);
  await runToFinishedBuild(store, project.id, taskId);
  const worktreeProjectId = getTask(store).worktreeProjectId;
  assert.ok(worktreeProjectId);

  // Open worktrees are left alone: no request, nothing flagged.
  assert.equal(
    await store.getState().checkTaskWorktree(project.id, taskId),
    true,
  );
  assert.deepEqual(store.getState().missingTaskWorktrees, {});

  closeProjectInStore(store, worktreeProjectId);
  assert.equal(
    await store.getState().checkTaskWorktree(project.id, taskId),
    true,
  );
  assert.deepEqual(store.getState().missingTaskWorktrees, {});

  // Merged and cleaned up by hand: neither folder nor branch is left.
  harness.worktreeOnDisk = false;
  harness.branchExists = false;
  assert.equal(
    await store.getState().checkTaskWorktree(project.id, taskId),
    false,
  );
  assert.deepEqual(store.getState().missingTaskWorktrees, {
    [taskId]: { branchExists: false },
  });

  // Finished tasks are never checked.
  store.getState().completeTask(project.id, taskId, {
    at: new Date().toISOString(),
    kind: "removed",
    mergeCommit: null,
    prUrl: null,
  });
  assert.equal(
    await store.getState().checkTaskWorktree(project.id, taskId),
    true,
  );
});
