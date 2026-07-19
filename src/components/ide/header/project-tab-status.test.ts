import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import {
  chatIsAwaitingAnswer,
  getAwaitingAnswerProjectIds,
} from "./project-tab-status";

const createQuestionPart = (
  overrides: Record<string, unknown> = {},
): UIMessage["parts"][number] =>
  ({
    approval: { id: "question-approval" },
    input: {
      questions: [
        {
          options: [{ label: "Yes" }, { label: "No" }],
          question: "Continue?",
        },
      ],
    },
    state: "approval-requested",
    toolCallId: "question-tool-call",
    toolName: "ask-user-question",
    type: "dynamic-tool",
    ...overrides,
  }) as UIMessage["parts"][number];

const createMessage = (
  id: string,
  role: UIMessage["role"],
  parts: UIMessage["parts"],
): UIMessage => ({ id, parts, role });

test("reports a pending final question as awaiting an answer", () => {
  assert.equal(
    chatIsAwaitingAnswer([
      createMessage("assistant-1", "assistant", [createQuestionPart()]),
    ]),
    true,
  );
});

test("recognizes completed question states", () => {
  assert.equal(
    chatIsAwaitingAnswer([
      createMessage("assistant-1", "assistant", [
        createQuestionPart({ state: "output-available" }),
      ]),
    ]),
    false,
  );
});

test("recognizes a recorded answer even when the provider state is stale", () => {
  assert.equal(
    chatIsAwaitingAnswer([
      createMessage("assistant-1", "assistant", [
        createQuestionPart({
          approval: {
            approved: true,
            id: "question-approval",
            reason: JSON.stringify({ answers: { question: "Yes" } }),
          },
        }),
      ]),
    ]),
    false,
  );
});

test("ignores a stale pending question after the conversation progresses", () => {
  assert.equal(
    chatIsAwaitingAnswer([
      createMessage("assistant-1", "assistant", [createQuestionPart()]),
      createMessage("assistant-2", "assistant", [
        { text: "Continuing with the answer.", type: "text" },
      ]),
    ]),
    false,
  );
});

test("uses a newer pending question after earlier conversation progress", () => {
  assert.equal(
    chatIsAwaitingAnswer([
      createMessage("assistant-1", "assistant", [createQuestionPart()]),
      createMessage("user-1", "user", [{ text: "Yes", type: "text" }]),
      createMessage("assistant-2", "assistant", [
        createQuestionPart({
          approval: { id: "new-question-approval" },
          toolCallId: "new-question-tool-call",
        }),
      ]),
    ]),
    true,
  );
});

test("uses project activity when the pending chat streaming flag is missing", () => {
  const pendingChat = {
    deletedAt: null,
    id: "pending-chat",
    projectId: "project-1",
  };
  const otherStreamingChat = {
    deletedAt: null,
    id: "streaming-chat",
    projectId: "project-1",
  };

  assert.deepEqual(
    getAwaitingAnswerProjectIds({
      chats: [pendingChat, otherStreamingChat],
      messagesByChatId: {
        [pendingChat.id]: [
          createMessage("assistant-1", "assistant", [createQuestionPart()]),
        ],
      },
      streamingProjectIds: new Set(["project-1"]),
    }),
    new Set(["project-1"]),
  );
});

test("does not restore an amber state for a project with no active run", () => {
  assert.deepEqual(
    getAwaitingAnswerProjectIds({
      chats: [
        {
          deletedAt: null,
          id: "stale-chat",
          projectId: "project-1",
        },
      ],
      messagesByChatId: {
        "stale-chat": [
          createMessage("assistant-1", "assistant", [createQuestionPart()]),
        ],
      },
      streamingProjectIds: new Set(),
    }),
    new Set(),
  );
});
