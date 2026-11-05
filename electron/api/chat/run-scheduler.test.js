import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { createHostCatalog } from "../../host/catalog.js";
import { createStateReadPool } from "../../state-read-pool.js";
import { createStateSaveQueue } from "../../state-save-queue.js";
import { streamAgentTurn } from "./agent-turn.js";
import { createDelegationService } from "./delegation.js";
import { createRunScheduler } from "./run-scheduler.js";
import { executeAgentTurn } from "./turn-execution.js";
import { createTurnRegistry } from "./turn-registry.js";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const until = async (read, predicate) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Queue did not settle.");
};

const request = (id, text = id) => ({
  requestId: id,
  chatId: "c",
  provider: "openai",
  model: "test",
  projectPath: "/workspace",
  message: { id, role: "user", parts: [{ type: "text", text }] },
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dream-run-queue-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "state.db");
  const writer = createStateSaveQueue({ databasePath });
  cleanups.push(() => writer.flushAndClose());
  const reader = createStateReadPool({ databasePath, whenReady: writer.ready });
  cleanups.push(() => reader.close());
  const catalog = createHostCatalog({
    events: { publish() {} },
    getWriter: () => writer,
    getReader: () => reader,
  });
  await catalog.applyChanges({
    projects: [{ id: "p", path: "/workspace", name: "p" }],
    chats: [{ id: "c", projectId: "p", title: "c" }],
  });
  return { writer, catalog };
}

function schedulerFor(catalog, execute) {
  const turns = createTurnRegistry();
  const scheduler = createRunScheduler({ catalog, turns, execute });
  cleanups.push(() => scheduler.close());
  return { scheduler, turns };
}

test("ordered durable submissions deduplicate and each sees the previous saved answer", async () => {
  const { catalog } = await setup();
  const inputs = [];
  const { scheduler } = schedulerFor(
    catalog,
    async (data, { signal, onChunk }) => {
      inputs.push(data.messages);
      return executeAgentTurn(
        {
          catalog,
          chatId: "c",
          requestMessages: data.messages,
          projectPath: "/workspace",
          onChunk,
        },
        () =>
          streamAgentTurn({
            provider: "openai",
            messages: data.messages,
            abortSignal: signal,
            execute: async (turn) => {
              turn.text(`answer ${inputs.length}`);
            },
          }),
      );
    },
  );
  const first = await scheduler.submit(request("one"));
  const duplicate = await scheduler.submit(request("one"));
  await scheduler.submit(request("two"));
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await until(
    () => scheduler.list("c"),
    (queue) =>
      queue.runs.length === 2 &&
      queue.runs.every((run) => run.status === "completed"),
  );
  assert.equal(inputs.length, 2);
  assert.deepEqual(
    inputs[1].map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(inputs[1][1].parts[0].text, "answer 1");
  await assert.rejects(
    scheduler.submit(request("one", "changed")),
    /different submission/,
  );
  await scheduler.submit(request("one"));
  assert.equal(inputs.length, 2);
});

test("process loss interrupts claimed work and holds remaining work until explicit resume", async () => {
  const { catalog, writer } = await setup();
  const { requestId, chatId, ...payload } = request("uncertain");
  await writer.mutateRunQueue({
    type: "enqueue",
    chatId,
    id: requestId,
    request: payload,
  });
  await writer.mutateRunQueue({ type: "claim", chatId });
  const second = request("next");
  const { requestId: nextId, chatId: nextChat, ...nextPayload } = second;
  await writer.mutateRunQueue({
    type: "enqueue",
    chatId: nextChat,
    id: nextId,
    request: nextPayload,
  });
  let calls = 0;
  const { scheduler } = schedulerFor(catalog, () => {
    calls++;
    return new Response("data: [DONE]\n\n");
  });
  const recovered = await scheduler.list("c");
  assert.equal(recovered.paused, true);
  assert.deepEqual(
    recovered.runs.map((run) => run.status),
    ["interrupted", "queued"],
  );
  await scheduler.submit(request("uncertain"));
  assert.equal(calls, 0);
  await scheduler.control({ chatId: "c", action: "resume" });
  await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[1].status === "completed",
  );
  assert.equal(calls, 1);
  assert.equal((await scheduler.list("c")).runs[0].status, "interrupted");
});

test("Stop holds the queue while the stopped turn settles; cancelled work never starts", async () => {
  const { catalog } = await setup();
  let calls = 0;
  let release;
  const { scheduler, turns } = schedulerFor(
    catalog,
    async (_data, { signal }) => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => {
                release = () => controller.close();
              },
              { once: true },
            );
          },
        }),
      );
    },
  );
  await scheduler.submit(request("one"));
  await scheduler.submit(request("two"));
  await until(() => Promise.resolve(turns.isRunning("c")), Boolean);
  // Wait until the provider has installed its abort listener.
  await until(
    () => Promise.resolve(calls),
    (value) => value === 1,
  );
  await scheduler.control({ chatId: "c", action: "stop" });
  assert.equal((await scheduler.list("c")).runs[0].status, "running");
  await scheduler.control({ chatId: "c", action: "cancel", id: "two" });
  release();
  // Stopped on purpose: finished business, not an interruption to review.
  await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[0].status === "cancelled",
  );
  await scheduler.control({ chatId: "c", action: "resume" });
  assert.equal(calls, 1);
  assert.equal((await scheduler.list("c")).runs[1].status, "cancelled");
});

test("after Stop, the next message runs without an explicit resume", async () => {
  const { catalog } = await setup();
  let calls = 0;
  const { scheduler, turns } = schedulerFor(
    catalog,
    async (_data, { signal }) => {
      calls++;
      if (calls > 1) return new Response("data: [DONE]\n\n");
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    },
  );
  await scheduler.submit(request("one"));
  await until(
    () => Promise.resolve(calls),
    (value) => value === 1,
  );
  await scheduler.control({ chatId: "c", action: "stop" });
  await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[0].status === "cancelled",
  );
  assert.equal(turns.isRunning("c"), false);
  await scheduler.submit(request("two"));
  const queue = await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[1]?.status === "completed",
  );
  assert.equal(queue.paused, false);
  assert.equal(calls, 2);
});

test("after a failure, a new message resumes the queue and dismisses the failed run", async () => {
  const { catalog } = await setup();
  let calls = 0;
  const { scheduler } = schedulerFor(catalog, async () => {
    calls++;
    if (calls === 1) throw new Error("Provider failed.");
    return new Response("data: [DONE]\n\n");
  });
  await scheduler.submit(request("one"));
  const failed = await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[0].status === "failed",
  );
  assert.equal(failed.paused, true);
  await scheduler.submit(request("two"));
  const queue = await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[1]?.status === "completed",
  );
  assert.equal(queue.paused, false);
  assert.equal(queue.runs[0].status, "cancelled");
});

test("pause holds queued work but lets the live turn finish; resume does not wait for it", async () => {
  const { catalog } = await setup();
  let calls = 0;
  let finish;
  const { scheduler, turns } = schedulerFor(catalog, async () => {
    calls++;
    if (calls > 1) return new Response("data: [DONE]\n\n");
    return new Response(
      new ReadableStream({
        start(controller) {
          finish = () => controller.close();
        },
      }),
    );
  });
  await scheduler.submit(request("one"));
  await scheduler.submit(request("two"));
  await until(
    () => Promise.resolve(calls),
    (value) => value === 1,
  );
  await scheduler.control({ chatId: "c", action: "pause" });
  finish();
  let queue = await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[0].status === "completed",
  );
  assert.equal(queue.paused, true);
  assert.equal(queue.runs[1].status, "queued");
  assert.equal(calls, 1);
  await scheduler.control({ chatId: "c", action: "resume" });
  queue = await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[1].status === "completed",
  );
  assert.equal(calls, 2);

  // Pausing and resuming during a live turn returns at once and the queue
  // continues after it.
  calls = 0;
  await scheduler.submit(request("three"));
  await scheduler.submit(request("four"));
  await until(
    () => Promise.resolve(calls),
    (value) => value === 1,
  );
  await scheduler.control({ chatId: "c", action: "pause" });
  await scheduler.control({ chatId: "c", action: "resume" });
  assert.equal(turns.isRunning("c"), true);
  finish();
  await until(
    () => scheduler.list("c"),
    (queue) => queue.runs.every((run) => run.status === "completed"),
  );
  assert.equal(calls, 2);
});

test("a failed or interrupted run can be removed instead of retried; a running one cannot", async () => {
  const { catalog } = await setup();
  let calls = 0;
  let finish;
  const { scheduler, turns } = schedulerFor(catalog, async () => {
    calls++;
    if (calls === 1) throw new Error("Provider failed.");
    return new Response(
      new ReadableStream({
        start(controller) {
          finish = () => controller.close();
        },
      }),
    );
  });
  await scheduler.submit(request("one"));
  await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[0].status === "failed",
  );
  await scheduler.control({ chatId: "c", action: "cancel", id: "one" });
  await scheduler.control({ chatId: "c", action: "retry", id: "one" });
  assert.equal((await scheduler.list("c")).runs[0].status, "cancelled");

  await scheduler.control({ chatId: "c", action: "resume" });
  await scheduler.submit(request("two"));
  // The chat is claimed before the provider answers: wait for its stream.
  await until(() => Promise.resolve(turns.isRunning("c") && finish), Boolean);
  await scheduler.control({ chatId: "c", action: "cancel", id: "two" });
  assert.equal((await scheduler.list("c")).runs[1].status, "running");
  finish();
  await until(
    () => scheduler.list("c"),
    (queue) => queue.runs[1].status === "completed",
  );
  assert.equal(calls, 2);
});

test("delegated tasks deduplicate, retain results across service restart, and enforce scope and permissions", async () => {
  const { catalog } = await setup();
  let parentScope;
  const { scheduler } = schedulerFor(
    catalog,
    async (data, { signal, orchestration }) => {
      if (data.chatId === "c") {
        parentScope = orchestration;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.close(), {
                once: true,
              });
            },
          }),
        );
      }
      assert.equal(data.provider, "openai");
      assert.equal(data.permissionMode, "ask");
      await catalog.saveTranscript(data.chatId, [
        ...data.messages,
        {
          id: "result",
          role: "assistant",
          parts: [{ type: "text", text: "Review complete." }],
        },
      ]);
      return new Response("data: [DONE]\n\n");
    },
  );
  const providers = {
    get: (id) => ({
      id,
      mcp: id !== "cursor",
      checkReady: async () =>
        id === "grok" ? { message: "Not installed." } : null,
    }),
    list: () => [],
  };
  const service = createDelegationService({ catalog, scheduler, providers });
  service.setEndpoint("http://localhost");
  scheduler.setDelegation(service);
  await scheduler.submit({
    ...request("parent"),
    provider: "anthropic",
    permissionMode: "ask",
  });
  await until(() => Promise.resolve(parentScope), Boolean);
  const call = async (name, args) => {
    const response = await parentScope.tools[name].handler(args);
    return {
      ...JSON.parse(response.content[0].text),
      isError: Boolean(response.isError),
    };
  };
  const input = {
    key: "review",
    provider: "openai",
    model: "reviewer",
    prompt: "Review the change",
  };
  assert.equal(
    (await call("delegate_task", { ...input, permissionMode: "full-access" }))
      .isError,
    true,
  );
  assert.equal(
    (await call("delegate_task", { ...input, provider: "grok" })).isError,
    true,
  );
  const child = await call("delegate_task", input);
  assert.equal(child.isError, false);
  assert.equal((await call("delegate_task", input)).duplicate, true);
  assert.equal(
    (await call("delegate_task", { ...input, prompt: "Different work" }))
      .isError,
    true,
  );
  await until(
    () => scheduler.list(child.childChatId),
    (queue) => queue.runs[0]?.status === "completed",
  );
  assert.equal(
    (await call("task_status", { id: child.id })).result,
    "Review complete.",
  );
  assert.equal((await call("task_status", { id: "unrelated" })).isError, true);
  assert.equal((await catalog.getChat(child.childChatId)).provider, "openai");
  assert.equal(
    (await catalog.getChat(child.childChatId)).permissionMode,
    "ask",
  );
  const token = parentScope.mcpServers[0].headers.Authorization;
  const mcpRequest = () =>
    new Request("http://localhost/api/mcp/orchestration", {
      method: "POST",
      headers: {
        Authorization: token,
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  assert.equal((await service.handle(mcpRequest())).status, 200);
  const restarted = createDelegationService({ catalog, scheduler, providers });
  assert.equal((await restarted.handle(mcpRequest())).status, 401);
  const nextScope = restarted.open(
    { id: "future-turn", chatId: "c", request: { provider: "anthropic" } },
    new AbortController().signal,
  );
  const savedResult = await nextScope.tools.task_status.handler({
    id: child.id,
  });
  assert.equal(
    JSON.parse(savedResult.content[0].text).result,
    "Review complete.",
  );
  nextScope.close();
  await scheduler.control({ chatId: "c", action: "stop" });
  assert.equal((await service.handle(mcpRequest())).status, 401);
  assert.equal(
    (await call("delegate_task", { ...input, key: "late" })).isError,
    true,
  );
});

test("parent Stop reaches running descendants and cancels their queued work", async () => {
  const { catalog } = await setup();
  const scopes = new Map();
  const { scheduler } = schedulerFor(
    catalog,
    async (data, { signal, orchestration }) => {
      scopes.set(data.chatId, orchestration);
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    },
  );
  scheduler.setDelegation(
    createDelegationService({
      catalog,
      scheduler,
      providers: {
        get: (id) => ({ id, mcp: true, checkReady: async () => null }),
        list: () => [],
      },
    }),
  );
  await scheduler.submit(request("parent"));
  await until(() => Promise.resolve(scopes.has("c")), Boolean);
  const child = JSON.parse(
    (
      await scopes.get("c").tools.delegate_task.handler({
        key: "child",
        provider: "anthropic",
        model: "test",
        prompt: "Work",
      })
    ).content[0].text,
  );
  await until(() => Promise.resolve(scopes.has(child.id)), Boolean);
  await scheduler.submit({ ...request("follow-up"), chatId: child.id });
  await catalog.applyChanges({
    chats: [
      {
        ...(await catalog.getChat(child.id)),
        deletedAt: new Date().toISOString(),
      },
    ],
  });
  await scheduler.control({ chatId: "c", action: "stop" });
  await until(
    () => scheduler.list(child.id),
    (queue) => queue.runs[0].status === "cancelled",
  );
  const childQueue = await scheduler.list(child.id);
  assert.equal(childQueue.paused, true);
  // Parent stop cancels every queued child submission, including later follow-ups.
  assert.equal(childQueue.runs[1].status, "cancelled");
});
