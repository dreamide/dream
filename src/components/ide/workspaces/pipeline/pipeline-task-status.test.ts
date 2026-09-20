import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatActivity } from "../../activity-store";
import {
  getPipelineStatusDotProps,
  getPipelineTaskStatus,
  isPipelineTaskSettled,
} from "./pipeline-task-status";

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
    getPipelineTaskStatus({
      ...base,
      currentRun: null,
      task: { ...base.task, step: "backlog" },
    }),
    "idle",
  );
  assert.equal(getPipelineTaskStatus({ ...base, currentRun: null }), "idle");
});

test("completion wins over everything else", () => {
  assert.equal(
    getPipelineTaskStatus({
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
  assert.equal(
    getPipelineTaskStatus({ ...base, pendingSubmit: true }),
    "starting",
  );
  assert.equal(getPipelineTaskStatus({ ...base, streaming: true }), "running");
  assert.equal(
    getPipelineTaskStatus({ ...base, awaitingAnswer: true, streaming: true }),
    "waiting",
  );
});

test("a finished run awaits approval even after its chat is deleted", () => {
  assert.equal(
    getPipelineTaskStatus({
      ...base,
      chatExists: false,
      currentRun: { chatId: null, finishedAt: "now" },
    }),
    "awaitingApproval",
  );
});

test("an unfinished run reflects the recorded activity", () => {
  assert.equal(
    getPipelineTaskStatus({ ...base, activityEntry: activity("failed") }),
    "failed",
  );
  assert.equal(
    getPipelineTaskStatus({ ...base, activityEntry: activity("waiting") }),
    "waiting",
  );
  // A queued prompt that never ran (e.g. app restart) needs a retry.
  assert.equal(getPipelineTaskStatus(base), "interrupted");
  assert.equal(
    getPipelineTaskStatus({ ...base, chatExists: false }),
    "missing",
  );
});

test("a closed worktree project blocks the task", () => {
  assert.equal(
    getPipelineTaskStatus({
      ...base,
      task: { ...base.task, worktreeProjectId: "worktree" },
      worktreeOpen: false,
    }),
    "worktreeClosed",
  );
});

test("only settled statuses allow approve, send back, and retry", () => {
  assert.equal(isPipelineTaskSettled("awaitingApproval"), true);
  assert.equal(isPipelineTaskSettled("failed"), true);
  assert.equal(isPipelineTaskSettled("running"), false);
  assert.equal(isPipelineTaskSettled("starting"), false);
  assert.equal(isPipelineTaskSettled("done"), false);
});

test("status dots pulse only while the agent is active", () => {
  assert.equal(getPipelineStatusDotProps("running").pulse, true);
  assert.equal(getPipelineStatusDotProps("awaitingApproval").pulse, false);
  assert.equal(getPipelineStatusDotProps("failed").className, "bg-destructive");
});
