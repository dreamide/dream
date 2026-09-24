import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { createChatActions } from "./chat-actions";
import type { IdeState } from "./ide-store-types";
import { createStashActions } from "./stash-actions";
import { createTaskActions } from "./task-actions";

const createTestStore = () => {
  const project = createProjectConfig("/workspace/dream", DEFAULT_SETTINGS);
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: project.id,
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        completedChatIds: {},
        draftChatIdByProject: {},
        messagesByChatId: {},
        pendingChatSubmitByChatId: {},
        projects: [project],
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        tasks: [],
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createChatActions(store.setState, store.getState),
    ...createStashActions(store.setState, store.getState),
    ...createTaskActions(store.setState, store.getState),
  });

  return { project, store };
};

test("addTask saves a trimmed task and refuses one without a title or prompt", () => {
  const { store } = createTestStore();

  const taskId = store
    .getState()
    .addTask({ prompt: "  Address the review  ", title: " Review " });
  assert.ok(taskId);
  assert.equal(store.getState().addTask({ prompt: "x", title: " " }), null);
  assert.equal(store.getState().addTask({ prompt: " ", title: "x" }), null);

  const { tasks } = store.getState();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, taskId);
  assert.equal(tasks[0]?.title, "Review");
  assert.equal(tasks[0]?.prompt, "Address the review");
});

test("updateTask edits in place and ignores blank values", () => {
  const { store } = createTestStore();
  const taskId = store
    .getState()
    .addTask({ prompt: "Old prompt", title: "Old" }) as string;
  const before = store.getState().tasks[0];

  store.getState().updateTask(taskId, { prompt: "New prompt", title: " " });

  const after = store.getState().tasks[0];
  assert.equal(after?.title, "Old");
  assert.equal(after?.prompt, "New prompt");
  assert.equal(after?.createdAt, before?.createdAt);

  // Nothing changed: the list is left as is.
  const tasks = store.getState().tasks;
  store.getState().updateTask(taskId, { title: "Old" });
  assert.equal(store.getState().tasks, tasks);
});

test("moveTask reorders and deleteTask removes", () => {
  const { store } = createTestStore();
  const ids = ["One", "Two", "Three"].map(
    (title) => store.getState().addTask({ prompt: title, title }) as string,
  );

  store.getState().moveTask(ids[2] as string, 0);
  assert.deepEqual(
    store.getState().tasks.map((task) => task.title),
    ["Three", "One", "Two"],
  );
  store.getState().moveTask(ids[2] as string, 99);
  assert.deepEqual(
    store.getState().tasks.map((task) => task.title),
    ["One", "Two", "Three"],
  );

  store.getState().deleteTask(ids[1] as string);
  assert.deepEqual(
    store.getState().tasks.map((task) => task.title),
    ["One", "Three"],
  );
});

test("runTask sends the filled-in prompt to the chat and keeps the task", () => {
  const { project, store } = createTestStore();
  const chatId = store.getState().addChat(project.id) as string;
  const taskId = store.getState().addTask({
    prompt: "Address the review comments on {{branch}} in {{project.name}}",
    title: "Review",
  }) as string;

  assert.equal(
    store.getState().runTask(project.id, taskId, { branch: "feature", chatId }),
    true,
  );
  assert.deepEqual(store.getState().pendingChatSubmitByChatId[chatId], {
    preserveDraft: true,
    references: [],
    text: `Address the review comments on feature in ${project.name}`,
  });
  // Running a task never uses it up.
  assert.equal(store.getState().tasks.length, 1);

  // The chat already has a queued prompt, so it is busy.
  assert.equal(store.getState().runTask(project.id, taskId, { chatId }), false);
});

test("runTask refuses a chat that is streaming or belongs to another project", () => {
  const { project, store } = createTestStore();
  const chatId = store.getState().addChat(project.id) as string;
  const taskId = store
    .getState()
    .addTask({ prompt: "Run the tests", title: "Test" }) as string;

  store.setState({ streamingChatIds: { [chatId]: true } });
  assert.equal(store.getState().runTask(project.id, taskId, { chatId }), false);

  store.setState({ streamingChatIds: {} });
  assert.equal(
    store.getState().runTask("other-project", taskId, { chatId }),
    false,
  );
});
