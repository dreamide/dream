import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatActivity } from "../../activity-store";
import {
  getTaskStatus,
  getTaskStatusDotProps,
  isTaskSettled,
} from "./task-status";

const activity = (status: ChatActivity["status"]): ChatActivity => ({
  detail: "",
  status,
  updatedAt: 0,
});

const base = {
  activityEntry: undefined,
  awaitingAnswer: false,
  chatExists: true,
  currentRun: { chatId: "chat-1", finishedAt: null },
  pendingSubmit: false,
  streaming: false,
  task: { completion: null, step: "build", worktreeProjectId: null },
  worktreeOpen: true,
} as const;

test("backlog tasks and unstarted steps are idle", () => {
  assert.equal(
    getTaskStatus({
      ...base,
      currentRun: null,
      task: { ...base.task, step: "backlog" },
    }),
    "idle",
  );
  assert.equal(getTaskStatus({ ...base, currentRun: null }), "idle");
});

test("completion wins over everything else", () => {
  assert.equal(
    getTaskStatus({
      ...base,
      streaming: true,
      task: {
        ...base.task,
        completion: {
          at: "now",
          kind: "merged",
          mergeCommit: null,
          prUrl: null,
        },
      },
    }),
    "done",
  );
});

test("live chat state maps to starting, running, and waiting", () => {
  assert.equal(getTaskStatus({ ...base, pendingSubmit: true }), "starting");
  assert.equal(getTaskStatus({ ...base, streaming: true }), "running");
  assert.equal(
    getTaskStatus({ ...base, awaitingAnswer: true, streaming: true }),
    "waiting",
  );
});

test("a finished run awaits approval even after its chat is deleted", () => {
  assert.equal(
    getTaskStatus({
      ...base,
      chatExists: false,
      currentRun: { chatId: null, finishedAt: "now" },
    }),
    "awaitingApproval",
  );
});

test("an unfinished run reflects the recorded activity", () => {
  assert.equal(
    getTaskStatus({ ...base, activityEntry: activity("failed") }),
    "failed",
  );
  assert.equal(
    getTaskStatus({ ...base, activityEntry: activity("waiting") }),
    "waiting",
  );
  // A queued prompt that never ran (e.g. app restart) needs a retry.
  assert.equal(getTaskStatus(base), "interrupted");
  assert.equal(getTaskStatus({ ...base, chatExists: false }), "missing");
});

test("a closed worktree project blocks the task", () => {
  assert.equal(
    getTaskStatus({
      ...base,
      task: { ...base.task, worktreeProjectId: "worktree" },
      worktreeOpen: false,
    }),
    "worktreeClosed",
  );
});

test("only settled statuses allow approve, send back, and retry", () => {
  assert.equal(isTaskSettled("awaitingApproval"), true);
  assert.equal(isTaskSettled("failed"), true);
  assert.equal(isTaskSettled("running"), false);
  assert.equal(isTaskSettled("starting"), false);
  assert.equal(isTaskSettled("done"), false);
});

test("status dots pulse only while the agent is active", () => {
  assert.equal(getTaskStatusDotProps("running").pulse, true);
  assert.equal(getTaskStatusDotProps("awaitingApproval").pulse, false);
  assert.equal(getTaskStatusDotProps("failed").className, "bg-destructive");
});
