import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, test, vi } from "vitest";
import { z } from "zod";
import { createHostCatalog } from "../../host/catalog.js";
import { getProviderCapabilities } from "../../shared/provider-capabilities.js";
import { createStateReadPool } from "../../state-read-pool.js";
import { createStateSaveQueue } from "../../state-save-queue.js";
import { resolveToolApproval } from "../tool-approvals.js";
import { turnObservers } from "./agent-turn.js";
import { streamCodexAppServerResponse } from "./codex-app-server.js";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import { startProviderSession } from "./provider-session.js";
import { createRunScheduler } from "./run-scheduler.js";
import { executeAgentTurn } from "./turn-execution.js";
import { createTurnRegistry } from "./turn-registry.js";
import { prepareTurnTranscript } from "./turn-transcript.js";

// Only the native JSON-RPC transport is replaced. Adapter and stream writer run unchanged.
vi.mock("./codex-app-server-client.js", () => ({
  getCodexAppServerClient: vi.fn(),
  onCodexSkillsChanged: () => () => {},
}));
let notify;
let outbound;
let replies;
beforeEach(() => {
  outbound = [];
  replies = [];
  getCodexAppServerClient.mockResolvedValue({
    hasThread: () => false,
    sendResponse: (id, result) => replies.push({ id, result }),
    registerThread: (_id, handlers) => {
      notify = handlers.onMessage;
      return () => {};
    },
    sendRequest: async (method, params) => {
      outbound.push({ method, params });
      if (method === "thread/start") return { thread: { id: "root" } };
      if (method === "turn/start") return { turn: { id: "turn-root" } };
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected native request: ${method}`);
    },
  });
});
const untilStarted = async () => {
  for (
    let i = 0;
    i < 100 && !outbound.some((frame) => frame.method === "turn/start");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(outbound.some((frame) => frame.method === "turn/start"));
};
const start = (signal) =>
  streamCodexAppServerResponse({
    abortSignal: signal,
    permissionMode: "ask",
    model: "test",
    projectPath: "/work",
    messages: [
      { id: "u", role: "user", parts: [{ type: "text", text: "Do the work" }] },
    ],
  });

test("child terminal frames cannot close the root; final text and native boundary survive", async () => {
  let ended = false;
  const result = start(new AbortController().signal)
    .text()
    .then((text) => {
      ended = true;
      return text;
    });
  await untilStarted();
  notify({
    method: "turn/completed",
    params: {
      threadId: "child",
      turn: { id: "turn-child", status: "completed" },
    },
  });
  await Promise.resolve();
  assert.equal(ended, false);
  for (const frame of [
    {
      method: "item/started",
      params: { item: { type: "agentMessage", id: "answer" } },
    },
    {
      method: "item/agentMessage/delta",
      params: { itemId: "answer", delta: "Still working after the child." },
    },
    {
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "answer" } },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "root",
        turn: { id: "turn-root", status: "completed" },
      },
    },
  ])
    notify(frame);
  const text = await result;
  assert.match(text, /Still working after the child/);
  assert.match(text, /nativeTurnId.*turn-root/);
});

test("Codex reports whether it resumed the thread it was given, and why not", async () => {
  const follow = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "First" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "Next" }] },
  ];
  const run = async ({ live }) => {
    const client = await getCodexAppServerClient();
    client.hasThread = () => live;
    const sendRequest = client.sendRequest;
    client.sendRequest = async (method, params) => {
      if (method === "thread/unarchive" || method === "thread/fork") {
        outbound.push({ method, params });
        throw new Error("no such thread");
      }
      return sendRequest(method, params);
    };
    outbound = [];
    const starts = [];
    const observer = {
      onMessage: () => {},
      onSessionStart: (start) => {
        starts.push(start);
        return {};
      },
    };
    const response = turnObservers.run(observer, () =>
      streamCodexAppServerResponse({
        abortSignal: new AbortController().signal,
        permissionMode: "ask",
        model: "test",
        projectPath: "/work",
        messages: follow,
        resumeSessionId: "saved",
        sessionHandoff: "Missed while away.",
      }),
    );
    await untilStarted();
    notify({
      method: "turn/completed",
      params: {
        threadId: live ? "saved" : "root",
        turn: { id: "turn-root", status: "completed" },
      },
    });
    await response.text();
    const input = outbound.find((frame) => frame.method === "turn/start").params
      .input[0].text;
    return { input, starts };
  };

  const resumed = await run({ live: true });
  assert.deepEqual(resumed.starts, [{ resumed: true }]);
  assert.equal(
    outbound.some((frame) => frame.method === "thread/start"),
    false,
  );
  assert.match(resumed.input, /Missed while away\./);
  assert.doesNotMatch(resumed.input, /First/);

  const fresh = await run({ live: false });
  assert.equal(fresh.starts.length, 1);
  assert.equal(fresh.starts[0].resumed, false);
  assert.match(
    fresh.starts[0].reason,
    /Codex could not restore the saved thread/,
  );
  assert.ok(outbound.some((frame) => frame.method === "thread/start"));
  assert.doesNotMatch(fresh.input, /Missed while away\./);
  assert.match(fresh.input, /First/);
});

test("a native turn is saved while it runs, before the provider says it is done", async () => {
  const saves = [];
  const turns = createTurnRegistry();
  const requestMessages = [
    { id: "u", role: "user", parts: [{ type: "text", text: "Do the work" }] },
  ];
  const running = turns.run({
    chatId: "c",
    run: (signal) =>
      executeAgentTurn(
        {
          catalog: {
            getChat: async () => null,
            saveTranscript: async (_chatId, messages) => {
              saves.push(messages.at(-1));
              return true;
            },
          },
          chatId: "c",
          requestMessages,
          saveIntervalMs: 20,
        },
        () => start(signal),
      ),
  });
  await untilStarted();
  notify({
    method: "item/started",
    params: { item: { type: "agentMessage", id: "answer" } },
  });
  notify({
    method: "item/agentMessage/delta",
    params: { itemId: "answer", delta: "Half way." },
  });
  const textOf = (message) =>
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  for (let i = 0; i < 100 && textOf(saves.at(-1)) !== "Half way."; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(textOf(saves.at(-1)), "Half way.");
  assert.equal(saves.at(-1).metadata.completedAt, undefined);
  assert.equal(turns.isRunning("c"), true);

  notify({
    method: "item/agentMessage/delta",
    params: { itemId: "answer", delta: " Done." },
  });
  notify({
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "answer" } },
  });
  notify({
    method: "turn/completed",
    params: {
      threadId: "root",
      turn: { id: "turn-root", status: "completed" },
    },
  });
  await running;
  assert.equal(textOf(saves.at(-1)), "Half way. Done.");
  assert.ok(saves.at(-1).metadata.completedAt);
});

test("interrupt acknowledgement waits for the provider terminal notification", async () => {
  const controller = new AbortController();
  let ended = false;
  const result = start(controller.signal)
    .text()
    .then(() => {
      ended = true;
    });
  await untilStarted();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(outbound.some((frame) => frame.method === "turn/interrupt"));
  assert.equal(ended, false);
  notify({
    method: "turn/completed",
    params: {
      threadId: "root",
      turn: { id: "turn-root", status: "interrupted" },
    },
  });
  await result;
});

test("an approval callback lost at restart is not reported as accepted", async () => {
  assert.deepEqual(
    await resolveToolApproval({ id: "openai:expired", approved: true }),
    { handled: false, status: "not-found" },
  );
});

test("dynamic delegation tools are thread-scoped and return native protocol results", async () => {
  const handler = vi.fn(async () => ({
    content: [{ type: "text", text: "Child queued." }],
  }));
  const output = streamCodexAppServerResponse({
    abortSignal: new AbortController().signal,
    permissionMode: "ask",
    model: "test",
    projectPath: "/work",
    messages: [
      {
        id: "u",
        role: "user",
        parts: [{ type: "text", text: "Delegate a review" }],
      },
    ],
    orchestrationTools: {
      delegate_task: {
        description: "Delegate",
        inputSchema: z.object({ key: z.string() }),
        handler,
      },
    },
  }).text();
  await untilStarted();
  assert.equal(
    outbound.find((frame) => frame.method === "thread/start").params
      .dynamicTools[0].name,
    "delegate_task",
  );
  notify({
    id: "wrong",
    method: "item/tool/call",
    params: {
      threadId: "child-thread",
      turnId: "turn-root",
      callId: "call-child",
      tool: "delegate_task",
      arguments: { key: "a" },
    },
  });
  notify({
    id: "right",
    method: "item/tool/call",
    params: {
      threadId: "root",
      turnId: "turn-root",
      callId: "call-root",
      tool: "delegate_task",
      arguments: { key: "a" },
    },
  });
  for (let i = 0; i < 100 && replies.length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(handler.mock.calls.length, 1);
  assert.equal(
    replies.find((reply) => reply.id === "wrong").result.success,
    false,
  );
  assert.deepEqual(replies.find((reply) => reply.id === "right").result, {
    success: true,
    contentItems: [{ type: "inputText", text: "Child queued." }],
  });
  notify({
    method: "turn/completed",
    params: {
      threadId: "root",
      turn: { id: "turn-root", status: "completed" },
    },
  });
  const text = await output;
  assert.match(text, /orchestrationToolsVersion/);
  assert.match(text, /Child queued/);
});

test("native replay reaches the durable queue, transcript writer and provider session coverage", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dream-native-replay-"),
  );
  const databasePath = path.join(directory, "state.db");
  const writer = createStateSaveQueue({ databasePath });
  const reader = createStateReadPool({ databasePath, whenReady: writer.ready });
  const catalog = createHostCatalog({
    events: { publish() {} },
    getWriter: () => writer,
    getReader: () => reader,
  });
  const scheduler = createRunScheduler({
    catalog,
    turns: createTurnRegistry(),
    execute: async (data, { signal, onChunk }) => {
      const transcript = prepareTurnTranscript(data.messages);
      const providerSession = await startProviderSession({
        catalog,
        chatId: data.chatId,
        provider: { id: "openai", ...getProviderCapabilities("openai") },
        messages: data.messages,
        transcript,
        projectPath: "/work",
        model: data.model,
      });
      return executeAgentTurn(
        {
          catalog,
          chatId: data.chatId,
          providerSession,
          requestMessages: data.messages,
          transcript,
          onChunk,
        },
        () =>
          streamCodexAppServerResponse({
            ...data,
            abortSignal: signal,
            resumeSessionId: providerSession.resumeSessionId,
            sessionHandoff: providerSession.handoff,
          }),
      );
    },
  });
  try {
    await catalog.applyChanges({
      projects: [{ id: "p", path: "/work", name: "p" }],
      chats: [{ id: "c", projectId: "p", title: "c" }],
    });
    const submission = {
      requestId: "request",
      chatId: "c",
      provider: "openai",
      model: "test",
      projectPath: "/work",
      permissionMode: "ask",
      message: {
        id: "u",
        role: "user",
        parts: [{ type: "text", text: "Work" }],
      },
    };
    await scheduler.submit(submission);
    await untilStarted();
    notify({
      method: "turn/completed",
      params: {
        threadId: "child",
        turn: { id: "child-turn", status: "completed" },
      },
    });
    assert.equal((await scheduler.list("c")).runs[0].status, "running");
    notify({
      id: "approve",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "root",
        turnId: "turn-root",
        itemId: "command",
        command: "pwd",
        cwd: "/work",
      },
    });
    for (
      let i = 0;
      i < 100 && (await scheduler.list("c")).runs[0].status !== "waiting";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await scheduler.list("c")).runs[0].status, "waiting");
    assert.equal(
      (
        await resolveToolApproval({
          id: "openai:command",
          approved: true,
          scope: "once",
        })
      ).handled,
      true,
    );
    assert.equal(
      (await resolveToolApproval({ id: "openai:command", approved: true }))
        .handled,
      false,
    );
    notify({
      method: "item/completed",
      params: {
        item: {
          id: "command",
          type: "commandExecution",
          command: "pwd",
          exitCode: 0,
          aggregatedOutput: "/work",
          status: "completed",
        },
      },
    });
    notify({
      method: "item/started",
      params: { item: { type: "agentMessage", id: "answer" } },
    });
    notify({
      method: "item/agentMessage/delta",
      params: { itemId: "answer", delta: "Saved final answer." },
    });
    notify({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "answer" } },
    });
    notify({
      method: "turn/completed",
      params: {
        threadId: "root",
        turn: { id: "turn-root", status: "completed" },
      },
    });
    for (
      let i = 0;
      i < 100 && (await scheduler.list("c")).runs[0].status !== "completed";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await scheduler.list("c")).runs[0].status, "completed");
    const transcript = JSON.parse(await catalog.getTranscriptJson("c"));
    assert.equal(
      transcript.at(-1).parts.find((part) => part.type === "text").text,
      "Saved final answer.",
    );
    assert.equal(transcript.at(-1).metadata.nativeTurnId, "turn-root");
    assert.equal(
      (await catalog.providerSession("c", "openai")).lastMessageId,
      transcript.at(-1).id,
    );
    assert.equal((await scheduler.submit(submission)).duplicate, true);
    assert.equal(
      outbound.filter((frame) => frame.method === "turn/start").length,
      1,
    );
  } finally {
    await scheduler.close();
    await reader.close();
    await writer.flushAndClose();
    await rm(directory, { recursive: true, force: true });
  }
});
