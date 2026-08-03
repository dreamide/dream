import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import {
  getLatestChatTodoSummary,
  isTaskCreateToolPart,
  isTaskUpdateToolPart,
  isTodoListPart,
  isTodoToolPart,
  normalizeChatTodos,
} from "@/components/ide/chat/todo-list";

const createToolPart = (
  type: string,
  overrides: Record<string, unknown> = {},
): UIMessage["parts"][number] =>
  ({
    state: "output-available",
    toolCallId: `${type}-call`,
    type,
    ...overrides,
  }) as UIMessage["parts"][number];

const createMessage = (
  id: string,
  parts: UIMessage["parts"],
  role: UIMessage["role"] = "assistant",
): UIMessage => ({ id, parts, role });

test("normalizeChatTodos converts plain strings into pending items", () => {
  assert.deepEqual(normalizeChatTodos(["Write tests", "  ", "Ship it"]), [
    { description: null, id: "todo-0", status: "pending", text: "Write tests" },
    { description: null, id: "todo-2", status: "pending", text: "Ship it" },
  ]);
});

test("normalizeChatTodos digs through nested payloads and JSON strings", () => {
  const todos = normalizeChatTodos({
    input: JSON.stringify({
      todos: [
        { content: "First", status: "in_progress" },
        { id: 7, title: "Second", completed: true },
        { description: "Only a description" },
      ],
    }),
  });

  assert.deepEqual(todos, [
    { description: null, id: "todo-0", status: "inProgress", text: "First" },
    { description: null, id: "7", status: "completed", text: "Second" },
    {
      description: null,
      id: "todo-2",
      status: "pending",
      text: "Only a description",
    },
  ]);
});

test("normalizeChatTodos returns null for payloads without a todo array", () => {
  assert.equal(normalizeChatTodos({ message: "no todos here" }), null);
  assert.equal(normalizeChatTodos("not json"), null);
  assert.equal(normalizeChatTodos(42), null);
});

test("tool part classifiers match normalized tool names", () => {
  const todoWrite = createToolPart("tool-TodoWrite");
  const taskCreate = createToolPart("dynamic-tool", { toolName: "TaskCreate" });
  const taskUpdate = createToolPart("tool-task_update");
  const textPart = {
    text: "hello",
    type: "text",
  } as UIMessage["parts"][number];

  assert.equal(isTodoToolPart(todoWrite), true);
  assert.equal(isTaskCreateToolPart(taskCreate), true);
  assert.equal(isTaskCreateToolPart(todoWrite), false);
  assert.equal(isTaskUpdateToolPart(taskUpdate), true);
  assert.equal(isTodoListPart(todoWrite), true);
  assert.equal(
    isTodoListPart({
      data: [],
      type: "data-todos",
    } as unknown as UIMessage["parts"][number]),
    true,
  );
  assert.equal(isTodoListPart(textPart), false);
});

test("getLatestChatTodoSummary uses the most recent todo list", () => {
  const summary = getLatestChatTodoSummary([
    createMessage("m1", [
      createToolPart("tool-TodoWrite", {
        input: { todos: [{ content: "Old plan", status: "pending" }] },
      }),
    ]),
    createMessage("m2", [
      createToolPart("tool-TodoWrite", {
        input: {
          todos: [
            { content: "Done step", status: "completed" },
            { content: "Active step", status: "in_progress" },
            { content: "Later step", status: "pending" },
          ],
        },
      }),
    ]),
  ]);

  assert.equal(summary.totalCount, 3);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.currentCount, 1);
  assert.equal(summary.currentTaskNumber, 2);
  assert.equal(summary.todos[1].text, "Active step");
});

test("getLatestChatTodoSummary builds a list from task create and update tools", () => {
  const summary = getLatestChatTodoSummary([
    createMessage("m1", [
      createToolPart("tool-TaskCreate", {
        input: { description: "Add coverage", subject: "Write tests" },
        output: "Created Task #1",
      }),
      createToolPart("tool-TaskCreate", {
        input: { subject: "Ship release" },
        output: "Created Task #2",
      }),
    ]),
    createMessage("m2", [
      createToolPart("tool-TaskUpdate", {
        input: { status: "in_progress", taskId: "1" },
      }),
    ]),
  ]);

  assert.deepEqual(summary.todos, [
    {
      description: "Add coverage",
      id: "task-1",
      status: "inProgress",
      text: "Write tests",
    },
    {
      description: null,
      id: "task-2",
      status: "pending",
      text: "Ship release",
    },
  ]);
  assert.equal(summary.currentTaskNumber, 1);
});

test("a task update for an unknown id appends a placeholder todo", () => {
  const summary = getLatestChatTodoSummary([
    createMessage("m1", [
      createToolPart("tool-TaskUpdate", {
        input: { status: "completed", taskId: "3" },
      }),
    ]),
  ]);

  assert.deepEqual(summary.todos, [
    { description: null, id: "task-3", status: "completed", text: "Task #3" },
  ]);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.currentTaskNumber, 1);
});

test("failed task tool calls are ignored", () => {
  const summary = getLatestChatTodoSummary([
    createMessage("m1", [
      createToolPart("tool-TaskCreate", {
        input: { subject: "Should not appear" },
        state: "output-error",
      }),
    ]),
  ]);

  assert.deepEqual(summary.todos, []);
  assert.equal(summary.totalCount, 0);
});

test("a todo list tool resets earlier task-create state", () => {
  const summary = getLatestChatTodoSummary([
    createMessage("m1", [
      createToolPart("tool-TaskCreate", {
        input: { subject: "Task style todo" },
        output: "Created Task #1",
      }),
      createToolPart("tool-TodoWrite", {
        input: { todos: [{ content: "Fresh list", status: "pending" }] },
      }),
    ]),
  ]);

  assert.equal(summary.totalCount, 1);
  assert.equal(summary.todos[0].text, "Fresh list");
});

test("data-todos parts feed the summary and empty history yields zero counts", () => {
  const summary = getLatestChatTodoSummary([
    createMessage("m1", [
      {
        data: ["From data part"],
        type: "data-todos",
      } as unknown as UIMessage["parts"][number],
    ]),
  ]);

  assert.equal(summary.todos[0].text, "From data part");

  const empty = getLatestChatTodoSummary([]);
  assert.deepEqual(empty, {
    completedCount: 0,
    currentCount: 0,
    currentTaskNumber: 0,
    todos: [],
    totalCount: 0,
  });
});
