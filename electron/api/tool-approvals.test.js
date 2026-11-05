import { afterEach, expect, test } from "vitest";
import {
  awaitingApprovalChatIds,
  onToolApprovalsChange,
  resolveToolApproval,
  waitForToolApproval,
} from "./tool-approvals.js";

const events = [];
const stop = onToolApprovalsChange((event) => events.push(event));

afterEach(() => {
  events.length = 0;
});

test("a chat is announced waiting from its first approval to its last", async () => {
  const first = waitForToolApproval({
    chatId: "c1",
    id: "claude:1",
    provider: "anthropic",
    request: {},
  });
  const second = waitForToolApproval({
    chatId: "c1",
    id: "claude:2",
    provider: "anthropic",
    request: {},
  });
  expect(awaitingApprovalChatIds()).toEqual(["c1"]);
  expect(events).toEqual([{ awaiting: true, chatId: "c1" }]);

  await resolveToolApproval({ approved: true, id: "claude:1", scope: "once" });
  expect(await first).toMatchObject({ approved: true });
  expect(events).toHaveLength(1);

  await resolveToolApproval({ approved: false, id: "claude:2", scope: "once" });
  expect(await second).toMatchObject({ approved: false });
  expect(events.at(-1)).toEqual({ awaiting: false, chatId: "c1" });
  expect(awaitingApprovalChatIds()).toEqual([]);
});

test("stopping the turn settles its approval and the chat's waiting", async () => {
  const controller = new AbortController();
  const pending = waitForToolApproval({
    chatId: "c2",
    id: "codex:1",
    provider: "openai",
    request: {},
    signal: controller.signal,
  });
  controller.abort();
  expect(await pending).toMatchObject({ approved: false });
  expect(events).toEqual([
    { awaiting: true, chatId: "c2" },
    { awaiting: false, chatId: "c2" },
  ]);
});

test("an approval without a chat is answered but never announced", async () => {
  const pending = waitForToolApproval({
    id: "grok:1",
    provider: "grok",
    request: {},
  });
  expect(awaitingApprovalChatIds()).toEqual([]);
  await resolveToolApproval({ approved: true, id: "grok:1", scope: "once" });
  await pending;
  expect(events).toEqual([]);
  stop();
});
