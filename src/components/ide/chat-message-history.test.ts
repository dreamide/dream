import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { mergeChatMessageHistories } from "@/components/ide/chat-message-history";

const createMessage = (
  id: string,
  role: UIMessage["role"],
  text: string,
  metadata?: Record<string, unknown>,
): UIMessage =>
  ({
    id,
    ...(metadata ? { metadata } : {}),
    parts: [{ text, type: "text" }],
    role,
  }) as UIMessage;

test("returns the next history when there is no previous history", () => {
  const next = [createMessage("u1", "user", "Hi")];

  assert.equal(mergeChatMessageHistories(undefined, next), next);
  assert.equal(mergeChatMessageHistories([], next), next);
});

test("keeps the previous history when the next history is empty", () => {
  const previous = [createMessage("u1", "user", "Hi")];

  assert.equal(mergeChatMessageHistories(previous, []), previous);
});

test("accepts a grown history that extends the previous one", () => {
  const previous = [
    createMessage("u1", "user", "Hi"),
    createMessage("a1", "assistant", "Hello"),
  ];
  const next = [
    ...previous,
    createMessage("a2", "assistant", "More output arrived"),
  ];

  assert.equal(mergeChatMessageHistories(previous, next), next);
});

test("accepts a streaming message that grew in place", () => {
  const previous = [
    createMessage("u1", "user", "Hi"),
    createMessage("a1", "assistant", "Partial"),
  ];
  const next = [
    createMessage("u1", "user", "Hi"),
    createMessage("a1", "assistant", "Partial answer now complete"),
  ];

  assert.equal(mergeChatMessageHistories(previous, next), next);
});

test("refuses a regression where a message shrank", () => {
  const user = createMessage("u1", "user", "Hi");
  const previous = [
    user,
    createMessage("a1", "assistant", "A long completed answer"),
  ];
  const next = [user, createMessage("a1", "assistant", "A")];

  assert.equal(mergeChatMessageHistories(previous, next), previous);
});

test("merges a grown message from a shorter next history by id", () => {
  const previous = [
    createMessage("u1", "user", "Hi"),
    createMessage("a1", "assistant", "Part"),
    createMessage("u2", "user", "Continue"),
  ];
  const next = [createMessage("a1", "assistant", "Partial grew longer")];

  const merged = mergeChatMessageHistories(previous, next);

  assert.notEqual(merged, previous);
  assert.deepEqual(
    merged.map((message) => message.id),
    ["u1", "a1", "u2"],
  );
  assert.equal(merged[1], next[0]);
});

test("keeps the full visible history when a shorter projection arrives", () => {
  const previous = [
    createMessage("u1", "user", "Hi"),
    createMessage("a1", "assistant", "One"),
    createMessage("a2", "assistant", "Two"),
    createMessage("a3", "assistant", "Three"),
  ];
  const next = [
    createMessage("summary", "assistant", "Compacted summary", {
      autoCompacted: true,
    }),
    createMessage("a3", "assistant", "Three"),
  ];

  assert.deepEqual(
    mergeChatMessageHistories(previous, next).map((message) => message.id),
    previous.map((message) => message.id),
  );
});

test("skips appending a duplicate trailing user message", () => {
  const user = createMessage("u1", "user", "Run the tests");
  const previous = [user];
  const next = [user, createMessage("u2", "user", "Run the tests")];

  assert.equal(mergeChatMessageHistories(previous, next), previous);
});

test("does not replace a message with one of a different role", () => {
  const previous = [createMessage("a1", "assistant", "Answer")];
  const next = [createMessage("u9", "user", "Completely different history")];

  assert.equal(mergeChatMessageHistories(previous, next), previous);
});
