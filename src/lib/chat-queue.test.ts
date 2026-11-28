import { expect, test, vi } from "vitest";
import {
  type ApiTransport,
  type ChatQueueResponse,
  type ChatRunSummary,
  createApiClient,
} from "./api-client";
import { createChatQueues, visibleQueueRuns } from "./chat-queue";

const run = (id: string, status: ChatRunSummary["status"]): ChatRunSummary => ({
  chatId: "chat-1",
  error: null,
  id,
  model: "model",
  provider: "provider",
  status,
  text: id,
});

const ids = (runs: ChatRunSummary[]) => runs.map((entry) => entry.id);

test("the live turn alone is not a queue", () => {
  expect(visibleQueueRuns([run("a", "running")])).toEqual([]);
  expect(visibleQueueRuns([run("a", "waiting")])).toEqual([]);
  expect(
    visibleQueueRuns([run("a", "completed"), run("b", "running")]),
  ).toEqual([]);
});

test("finished runs are never listed", () => {
  expect(
    visibleQueueRuns([run("a", "completed"), run("b", "cancelled")]),
  ).toEqual([]);
});

test("a queued follow-up lists the live turn with it", () => {
  expect(
    ids(
      visibleQueueRuns([
        run("a", "completed"),
        run("b", "running"),
        run("c", "queued"),
      ]),
    ),
  ).toEqual(["b", "c"]);
});

test("interrupted and failed runs need attention", () => {
  expect(ids(visibleQueueRuns([run("a", "interrupted")]))).toEqual(["a"]);
  expect(ids(visibleQueueRuns([run("a", "failed")]))).toEqual(["a"]);
});

const workspace = {
  chats: [{ id: "chat", projectId: "project" }],
  projects: [{ id: "project", hostId: "first" }],
  closedProjects: [],
};
const paused = { paused: true, runs: [] };
const running = { paused: false, runs: [] };

test("successful controls that finish out of order clear an earlier error", async () => {
  const pauseReceipt = Promise.withResolvers<ChatQueueResponse>();
  const resumeRead = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi
    .fn<ApiTransport>()
    .mockRejectedValueOnce(new Error("Cannot cancel"))
    .mockReturnValueOnce(pauseReceipt.promise)
    .mockResolvedValueOnce(running)
    .mockReturnValueOnce(resumeRead.promise)
    .mockResolvedValueOnce(paused);
  const queues = createChatQueues(createApiClient(transport));
  queues.observe(workspace);
  await queues.control({ chatId: "chat", action: "cancel", id: "run" });
  const pause = queues.control({ chatId: "chat", action: "pause" });
  const resume = queues.control({ chatId: "chat", action: "resume" });
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(4));
  pauseReceipt.resolve(paused);
  await pause;
  resumeRead.resolve(running);
  await resume;
  expect(queues.views.getState().get("chat")).toEqual({ queue: paused });
});

test("a failed control preserves a pending Host read and its own error until the next refresh", async () => {
  const reply = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi
    .fn<ApiTransport>()
    .mockResolvedValueOnce(running)
    .mockReturnValueOnce(reply.promise)
    .mockRejectedValueOnce(new Error("Cannot cancel"))
    .mockResolvedValue(paused);
  const queues = createChatQueues(createApiClient(transport));
  queues.observe(workspace);
  await queues.refresh("chat");
  const read = queues.refresh("chat");
  await queues.control({ chatId: "chat", action: "cancel", id: "run" });
  reply.resolve(paused);
  await read;
  expect(queues.views.getState().get("chat")).toEqual({
    queue: paused,
    error: "Cannot cancel",
  });
  await queues.refresh("chat");
  expect(queues.views.getState().get("chat")).toEqual({ queue: paused });
});

test("an earlier successful control updates the queue without hiding a later control failure", async () => {
  const receipt = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi
    .fn<ApiTransport>()
    .mockReturnValueOnce(receipt.promise)
    .mockRejectedValueOnce(new Error("Cannot resume"))
    .mockResolvedValue(paused);
  const queues = createChatQueues(createApiClient(transport));
  queues.observe(workspace);
  const pause = queues.control({ chatId: "chat", action: "pause" });
  await queues.control({ chatId: "chat", action: "resume" });
  receipt.resolve(paused);
  await pause;
  expect(queues.views.getState().get("chat")).toEqual({
    queue: paused,
    error: "Cannot resume",
  });
});

test.each([
  "success",
  "failure",
])("a late control %s belongs to the removed Chat", async (result) => {
  const receipt = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi
    .fn<ApiTransport>()
    .mockReturnValueOnce(receipt.promise)
    .mockResolvedValue(running);
  const queues = createChatQueues(createApiClient(transport));
  queues.observe(workspace);
  const control = queues.control({ chatId: "chat", action: "pause" });
  expect(transport.mock.calls[0][0]).toMatchObject({
    name: "controlChatQueue",
    hostId: "first",
  });

  queues.observe({ ...workspace, chats: [] });
  await queues.refresh("chat");
  queues.observe(workspace);
  await queues.refresh("chat");
  if (result === "success") receipt.resolve(paused);
  else receipt.reject(new Error("Old control"));
  await control;
  expect(transport).toHaveBeenCalledTimes(2);
  expect(queues.views.getState().get("chat")).toEqual({ queue: running });
});

test("a moved Project reads its queue on its new connection and keeps it when closed", async () => {
  const old = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi
    .fn<ApiTransport>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(paused);
  const queues = createChatQueues(createApiClient(transport));
  queues.observe(workspace);
  const first = queues.refresh("chat");
  const moved = {
    ...workspace,
    projects: [{ id: "project", hostId: "second" }],
  };
  queues.observe(moved, workspace);
  await vi.waitFor(() =>
    expect(queues.views.getState().get("chat")).toEqual({ queue: paused }),
  );
  queues.observe(
    { ...moved, projects: [], closedProjects: moved.projects },
    moved,
  );
  await queues.refresh("chat", "first");
  old.reject(new Error("Old connection"));
  await first;
  expect(transport.mock.calls.map(([request]) => request.hostId)).toEqual([
    "first",
    "second",
  ]);
  expect(queues.views.getState().get("chat")).toEqual({ queue: paused });
});

test("a control in flight on the old connection cannot refresh the new connection", async () => {
  const receipt = Promise.withResolvers<ChatQueueResponse>();
  const transport = vi
    .fn<ApiTransport>()
    .mockReturnValueOnce(receipt.promise)
    .mockResolvedValue(running);
  const queues = createChatQueues(createApiClient(transport));
  queues.observe(workspace);
  const control = queues.control({ chatId: "chat", action: "pause" });
  queues.observe(
    { ...workspace, projects: [{ id: "project", hostId: "new" }] },
    workspace,
  );
  receipt.resolve(paused);
  await control;
  expect(
    transport.mock.calls.map(([request]) => [request.name, request.hostId]),
  ).toEqual([
    ["controlChatQueue", "first"],
    ["chatQueue", "new"],
  ]);
  expect(queues.views.getState().get("chat")).toEqual({ queue: running });
});
