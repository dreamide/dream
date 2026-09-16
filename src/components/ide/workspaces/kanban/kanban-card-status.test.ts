import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatActivity } from "../../activity-store";
import {
  getKanbanCardStatus,
  getKanbanStatusDotProps,
} from "./kanban-card-status";

const activity = (status: ChatActivity["status"]): ChatActivity => ({
  detail: "",
  status,
  updatedAt: 0,
});

test("getKanbanCardStatus derives status from chat linkage and runtime state", () => {
  const base = {
    activityEntry: undefined,
    awaitingAnswer: false,
    chatExists: true,
    streaming: false,
  };

  assert.equal(
    getKanbanCardStatus({ ...base, card: { chatId: null } }),
    "idle",
  );
  assert.equal(
    getKanbanCardStatus({
      ...base,
      card: { chatId: "chat" },
      chatExists: false,
    }),
    "missing",
  );
  assert.equal(
    getKanbanCardStatus({
      ...base,
      awaitingAnswer: true,
      card: { chatId: "chat" },
      streaming: true,
    }),
    "waiting",
  );
  assert.equal(
    getKanbanCardStatus({ ...base, card: { chatId: "chat" }, streaming: true }),
    "running",
  );
  assert.equal(
    getKanbanCardStatus({
      ...base,
      activityEntry: activity("finished"),
      card: { chatId: "chat" },
    }),
    "finished",
  );
  assert.equal(
    getKanbanCardStatus({
      ...base,
      activityEntry: activity("failed"),
      card: { chatId: "chat" },
    }),
    "failed",
  );
  assert.equal(
    getKanbanCardStatus({
      ...base,
      activityEntry: activity("running"),
      card: { chatId: "chat" },
    }),
    "idle",
  );
});

test("getKanbanStatusDotProps maps statuses to dot styles", () => {
  assert.deepEqual(getKanbanStatusDotProps("running"), {
    color: "blue",
    pulse: true,
  });
  assert.deepEqual(getKanbanStatusDotProps("waiting"), {
    color: "amber",
    pulse: true,
  });
  assert.deepEqual(getKanbanStatusDotProps("finished"), {
    color: "green",
    pulse: false,
  });
  assert.equal(getKanbanStatusDotProps("failed").className, "bg-destructive");
  assert.equal(getKanbanStatusDotProps("idle").pulse, false);
});
