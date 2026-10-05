// A live turn's view: what it already finished keeps its identity from one
// stream update to the next, and what it changes does not.
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import {
  estimateMessages,
  estimateStableMessages,
} from "@/components/ide/chat/message-token-estimate";
import {
  reuseIfSameItems,
  stabilizeMessages,
} from "@/components/ide/chat/stable-messages";
import { getLatestChatTodoSummary } from "@/components/ide/chat/todo-list";

type Part = UIMessage["parts"][number];

const text = (value: string): Part => ({ text: value, type: "text" });
const tool = (id: string, output: unknown): Part =>
  ({
    input: { command: `run ${id}` },
    output,
    state: "output-available",
    toolCallId: id,
    type: "tool-Bash",
  }) as Part;

const user: UIMessage = { id: "u1", parts: [text("Go")], role: "user" };

/** What the AI SDK hands the view on every chunk: every part copied. */
const sdkCopy = (message: UIMessage): UIMessage => ({
  ...message,
  metadata:
    message.metadata && typeof message.metadata === "object"
      ? { ...message.metadata }
      : message.metadata,
  parts: message.parts.map((part) => ({ ...part })),
});

test("a streamed chunk keeps every part it did not change", () => {
  const live: UIMessage = {
    id: "a1",
    metadata: { model: "m" },
    parts: [tool("t1", "done"), text("Wor")],
    role: "assistant",
  };
  const first = stabilizeMessages(null, [user, sdkCopy(live)]);

  const next = sdkCopy(live);
  (next.parts[1] as { text: string }).text = "Working";
  const second = stabilizeMessages(first, [user, next]);

  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.equal(second[1].parts[0], first[1].parts[0]);
  assert.notEqual(second[1].parts[1], first[1].parts[1]);
  assert.equal((second[1].parts[1] as { text: string }).text, "Working");
  assert.equal(second[1].metadata, first[1].metadata);
});

test("a chunk that changed nothing gives back the same messages", () => {
  const live: UIMessage = {
    id: "a1",
    metadata: { model: "m" },
    parts: [text("Done")],
    role: "assistant",
  };
  const first = stabilizeMessages(null, [user, sdkCopy(live)]);

  assert.equal(stabilizeMessages(first, [user, sdkCopy(live)]), first);
});

test("a message the SDK is still writing into is never shared", () => {
  // The SDK shows a turn's message first as the object it keeps writing.
  const live: UIMessage = { id: "a1", parts: [text("Wor")], role: "assistant" };
  const first = stabilizeMessages(null, [user, live]);
  (live.parts[0] as { text: string }).text = "Working";

  const second = stabilizeMessages(first, [user, sdkCopy(live)]);

  assert.equal((first[1].parts[0] as { text: string }).text, "Wor");
  assert.notEqual(second[1].parts[0], first[1].parts[0]);
  assert.equal((second[1].parts[0] as { text: string }).text, "Working");
});

test("a different message at the same place is taken as it is", () => {
  const first = stabilizeMessages(null, [
    user,
    { id: "a1", parts: [text("One")], role: "assistant" },
  ]);
  const second = stabilizeMessages(first, [
    user,
    { id: "a2", parts: [text("One")], role: "assistant" },
  ]);

  assert.equal(second[1].id, "a2");
  assert.notEqual(second[1].parts[0], first[1].parts[0]);
});

test("a derived array is reused while it holds the same items", () => {
  const part = text("x");
  const previous = [part, null];

  assert.equal(reuseIfSameItems(previous, [part, null]), previous);
  assert.notEqual(reuseIfSameItems(previous, [part, null, null]), previous);
  assert.notEqual(reuseIfSameItems(previous, [text("x"), null]), previous);
});

test("the stable token estimate matches the full one as a turn grows", () => {
  let live: UIMessage = {
    id: "a1",
    parts: [tool("t1", { stdout: "x".repeat(4000) })],
    role: "assistant",
  };
  let view = stabilizeMessages(null, [user, sdkCopy(live)]);
  assert.equal(estimateStableMessages(view), estimateMessages(view));

  live = { ...live, parts: [...live.parts, text("Reading the output now")] };
  view = stabilizeMessages(view, [user, sdkCopy(live)]);
  assert.equal(estimateStableMessages(view), estimateMessages(view));
});

test("the todo summary is the same whether earlier messages were folded before", () => {
  const todos = (id: string, items: string[]): UIMessage => ({
    id,
    parts: [
      {
        input: { todos: items.map((item) => ({ content: item })) },
        output: null,
        state: "output-available",
        toolCallId: `${id}-todo`,
        type: "tool-TodoWrite",
      } as Part,
    ],
    role: "assistant",
  });
  const history = [user, todos("a1", ["one", "two"]), user];

  const cold = getLatestChatTodoSummary([...history, todos("a2", ["three"])]);
  getLatestChatTodoSummary(history);
  const warm = getLatestChatTodoSummary([...history, todos("a2", ["three"])]);

  assert.deepEqual(warm, cold);
  assert.deepEqual(
    warm.todos.map((todo) => todo.text),
    ["three"],
  );
  // A changed history is folded again, not read from the cache.
  assert.deepEqual(
    getLatestChatTodoSummary([user, todos("a3", ["four"]), user]).todos.map(
      (todo) => todo.text,
    ),
    ["four"],
  );
});
