import type { UIMessage } from "ai";
import { getToolName, isToolLikePart } from "../assistant-message-tools";

export type ChatTodoStatus = "pending" | "inProgress" | "completed";

export interface ChatTodoItem {
  description: string | null;
  id: string;
  status: ChatTodoStatus;
  text: string;
}

export interface ChatTodoSummary {
  completedCount: number;
  currentCount: number;
  currentTaskNumber: number;
  todos: ChatTodoItem[];
  totalCount: number;
}

const TODO_DATA_PART_TYPES = new Set(["data-todos", "data-todo-list"]);
const TODO_ARRAY_KEYS = [
  "todos",
  "tasks",
  "items",
  "plan",
  "steps",
  "entries",
  "data",
  "input",
  "arguments",
  "args",
  "result",
] as const;
const TODO_TEXT_KEYS = [
  "step",
  "content",
  "subject",
  "title",
  "task",
  "text",
  "label",
  "name",
] as const;
const TODO_DESCRIPTION_KEYS = [
  "description",
  "details",
  "detail",
  "note",
] as const;
const TODO_STATUS_KEYS = ["status", "state"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getStringValue = (
  record: Record<string, unknown>,
  keys: readonly string[],
) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const normalizeTodoStatus = (value: unknown): ChatTodoStatus => {
  if (typeof value === "boolean") {
    return value ? "completed" : "pending";
  }

  const normalized =
    typeof value === "string"
      ? value.replace(/[\s_-]+/g, "").toLowerCase()
      : "";

  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done" ||
    normalized === "success"
  ) {
    return "completed";
  }

  if (
    normalized === "inprogress" ||
    normalized === "current" ||
    normalized === "active" ||
    normalized === "running"
  ) {
    return "inProgress";
  }

  return "pending";
};

const normalizeTodoItem = (
  value: unknown,
  index: number,
): ChatTodoItem | null => {
  if (typeof value === "string") {
    const text = value.trim();
    return text
      ? {
          description: null,
          id: `todo-${index}`,
          status: "pending",
          text,
        }
      : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const text = getStringValue(value, TODO_TEXT_KEYS);
  const description = getStringValue(value, TODO_DESCRIPTION_KEYS);
  const fallbackText = description ?? null;
  const id =
    getStringValue(value, ["id", "taskId", "task_id"]) ?? `todo-${index}`;
  const statusValue =
    TODO_STATUS_KEYS.map((key) => value[key]).find(
      (candidate) => candidate !== undefined,
    ) ?? value.completed;

  if (!text && !fallbackText) {
    return null;
  }

  return {
    description: text ? description : null,
    id,
    status: normalizeTodoStatus(statusValue),
    text: text ?? fallbackText ?? "",
  };
};

export const normalizeChatTodos = (value: unknown): ChatTodoItem[] | null => {
  const getTodoArrayFromValue = (
    candidate: unknown,
    depth = 0,
  ): unknown[] | null => {
    if (depth > 4) {
      return null;
    }

    if (typeof candidate === "string") {
      try {
        return getTodoArrayFromValue(JSON.parse(candidate), depth + 1);
      } catch {
        return null;
      }
    }

    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (!isRecord(candidate)) {
      return null;
    }

    for (const key of TODO_ARRAY_KEYS) {
      const todos = getTodoArrayFromValue(candidate[key], depth + 1);
      if (todos) {
        return todos;
      }
    }

    return null;
  };

  const rawTodos = getTodoArrayFromValue(value);

  if (!rawTodos) {
    return null;
  }

  return rawTodos.flatMap((item, index) => {
    const normalized = normalizeTodoItem(item, index);
    return normalized ? [normalized] : [];
  });
};

const normalizeToolName = (name: string) =>
  name
    .split(/[.:/]+/)
    .pop()
    ?.replace(/[\s_-]+/g, "")
    .toLowerCase() ?? "";

export const isTaskCreateToolPart = (part: UIMessage["parts"][number]) => {
  if (!isToolLikePart(part)) {
    return false;
  }

  const toolName = normalizeToolName(getToolName(part));
  return toolName === "taskcreate" || toolName === "createtask";
};

export const isTodoToolPart = (part: UIMessage["parts"][number]) => {
  if (!isToolLikePart(part)) {
    return false;
  }

  const toolName = normalizeToolName(getToolName(part));
  return (
    toolName === "todowrite" ||
    toolName === "todo" ||
    toolName === "todolist" ||
    toolName === "todos" ||
    toolName === "taskcreate" ||
    toolName === "createtask" ||
    toolName === "updatetodo" ||
    toolName === "updatetodos" ||
    toolName === "updateplan"
  );
};

export const isTodoListPart = (part: UIMessage["parts"][number]) =>
  (typeof part.type === "string" && TODO_DATA_PART_TYPES.has(part.type)) ||
  isTodoToolPart(part);

const getTodosFromPart = (
  part: UIMessage["parts"][number],
): ChatTodoItem[] | null => {
  if (typeof part.type === "string" && TODO_DATA_PART_TYPES.has(part.type)) {
    return "data" in part ? normalizeChatTodos(part.data) : null;
  }

  if (!isTodoToolPart(part)) {
    return null;
  }

  if ("input" in part) {
    const inputTodos = normalizeChatTodos(part.input);
    if (inputTodos) {
      return inputTodos;
    }
  }

  if ("output" in part) {
    return normalizeChatTodos(part.output);
  }

  return null;
};

const getTaskCreateNumber = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/\bTask\s*#(\d+)\b/i);
  return match?.[1] ?? null;
};

const getTaskCreateItemFromPart = (
  part: UIMessage["parts"][number],
  fallbackIndex: number,
): ChatTodoItem | null => {
  if (!isTaskCreateToolPart(part)) {
    return null;
  }

  if (
    "state" in part &&
    (part.state === "output-error" || part.state === "output-denied")
  ) {
    return null;
  }

  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;

  const inputRecord = isRecord(input) ? input : null;
  const outputRecord = isRecord(output) ? output : null;
  const subject = inputRecord
    ? getStringValue(inputRecord, TODO_TEXT_KEYS)
    : null;
  const description = inputRecord
    ? getStringValue(inputRecord, TODO_DESCRIPTION_KEYS)
    : null;
  const outputNumber = getTaskCreateNumber(output);
  const id =
    (inputRecord
      ? getStringValue(inputRecord, ["id", "taskId", "task_id"])
      : null) ??
    (outputRecord
      ? getStringValue(outputRecord, ["id", "taskId", "task_id"])
      : null) ??
    (outputNumber ? `task-${outputNumber}` : `task-create-${fallbackIndex}`);

  if (!subject) {
    return null;
  }

  return {
    description,
    id,
    status: "pending",
    text: subject,
  };
};

const upsertTodo = (todos: ChatTodoItem[], nextTodo: ChatTodoItem) => {
  const existingIndex = todos.findIndex((todo) => todo.id === nextTodo.id);

  if (existingIndex === -1) {
    return [...todos, nextTodo];
  }

  return todos.map((todo, index) =>
    index === existingIndex ? { ...todo, ...nextTodo } : todo,
  );
};

export const getLatestChatTodoSummary = (
  messages: UIMessage[],
): ChatTodoSummary => {
  let latestTodos: ChatTodoItem[] = [];
  let taskCreateTodos: ChatTodoItem[] = [];
  let taskCreateIndex = 0;

  for (const message of messages) {
    for (const part of message.parts) {
      const taskCreateTodo = getTaskCreateItemFromPart(part, taskCreateIndex);
      if (taskCreateTodo) {
        taskCreateTodos = upsertTodo(taskCreateTodos, taskCreateTodo);
        latestTodos = taskCreateTodos;
        taskCreateIndex += 1;
        continue;
      }

      const todos = getTodosFromPart(part);
      if (todos) {
        latestTodos = todos;
        taskCreateTodos = [];
      }
    }
  }

  const completedCount = latestTodos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const currentCount = latestTodos.filter(
    (todo) => todo.status === "inProgress",
  ).length;
  const currentTaskIndex = latestTodos.findIndex(
    (todo) => todo.status === "inProgress",
  );
  const currentTaskNumber =
    currentTaskIndex === -1 ? completedCount : currentTaskIndex + 1;

  return {
    completedCount,
    currentCount,
    currentTaskNumber,
    todos: latestTodos,
    totalCount: latestTodos.length,
  };
};
