import { expect, test } from "vitest";
import { getActivityNotificationKind } from "./activity-notifications";
import type { ChatTurn, TurnStatus } from "./chat-turn-outcome";

const activity = (status: TurnStatus): ChatTurn => ({
  detail: "",
  status,
  updatedAt: 0,
});
const kind = (previous: TurnStatus | null, next: TurnStatus) =>
  getActivityNotificationKind(
    previous ? activity(previous) : undefined,
    activity(next),
  );

test("a turn that ends on its own or starts waiting is worth a notification", () => {
  expect(kind("running", "finished")).toBe("finished");
  expect(kind("running", "failed")).toBe("failed");
  expect(kind("running", "waiting")).toBe("waiting");
  expect(kind("waiting", "finished")).toBe("finished");
  expect(kind("waiting", "failed")).toBe("failed");
});

test("nothing else is", () => {
  // Stopped by the user, or lost with its connection.
  expect(kind("running", "interrupted")).toBeNull();
  // Answered, started, unchanged, or a chat first seen already settled.
  expect(kind("waiting", "running")).toBeNull();
  expect(kind("finished", "running")).toBeNull();
  expect(kind("running", "running")).toBeNull();
  expect(kind(null, "finished")).toBeNull();
  expect(kind("finished", "failed")).toBeNull();
  expect(kind("interrupted", "waiting")).toBeNull();
});
