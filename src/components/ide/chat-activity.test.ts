// Chat activity through its questions: each signal the store keeps, alone,
// and what each question answers for it.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type ChatActivityState,
  chatAcceptsMessage,
  chatIdsWaitingOnUser,
  isChatRunning,
  isChatWaitingOnUser,
  isProjectRunning,
  projectIdsWithRunningChats,
} from "./chat-activity";

const none: ChatActivityState = {
  awaitingAnswerChatIds: {},
  hostAwaitingApprovalChatIds: {},
  hostRunningChatIds: {},
  pendingChatSubmitByChatId: {},
  streamingChatIds: {},
};

/** The store with one signal set for chat `c`. */
const only = (signal: keyof ChatActivityState): ChatActivityState => ({
  ...none,
  [signal]: { c: signal === "pendingChatSubmitByChatId" ? {} : true },
});

test("each signal answers each question", () => {
  const cases: [
    keyof ChatActivityState | null,
    { running: boolean; waiting: boolean; accepts: boolean },
  ][] = [
    [null, { accepts: true, running: false, waiting: false }],
    // A session here streams it.
    ["streamingChatIds", { accepts: false, running: true, waiting: false }],
    // A turn runs on the host that no session here follows: it runs, and a
    // message still goes, for the host to queue.
    ["hostRunningChatIds", { accepts: true, running: true, waiting: false }],
    ["awaitingAnswerChatIds", { accepts: true, running: false, waiting: true }],
    [
      "hostAwaitingApprovalChatIds",
      { accepts: true, running: false, waiting: true },
    ],
    // A message is queued here already.
    [
      "pendingChatSubmitByChatId",
      { accepts: false, running: false, waiting: false },
    ],
  ];
  for (const [signal, expected] of cases) {
    const state = signal ? only(signal) : none;
    assert.deepEqual(
      {
        accepts: chatAcceptsMessage(state, "c"),
        running: isChatRunning(state, "c"),
        waiting: isChatWaitingOnUser(state, "c"),
      },
      expected,
      String(signal),
    );
  }
});

test("a project runs while any chat in it runs, here or on the host", () => {
  const chats = [
    { id: "a", projectId: "p1" },
    { id: "b", projectId: "p2" },
    { id: "c", projectId: "p3" },
  ];
  const state = {
    ...none,
    hostRunningChatIds: { b: true as const },
    streamingChatIds: { a: true as const },
  };
  assert.deepEqual([...projectIdsWithRunningChats(state, chats)].sort(), [
    "p1",
    "p2",
  ]);
  assert.equal(isProjectRunning({ ...state, chats } as never, "p2"), true);
  assert.equal(isProjectRunning({ ...state, chats } as never, "p3"), false);
});

test("the chats waiting on their user are this window's and the host's together", () => {
  assert.deepEqual(
    chatIdsWaitingOnUser({
      ...none,
      awaitingAnswerChatIds: { a: true, gone: false },
      hostAwaitingApprovalChatIds: { a: true, b: true },
    }),
    { a: true, b: true },
  );
});
