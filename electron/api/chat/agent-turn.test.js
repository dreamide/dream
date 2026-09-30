// The contract every provider adapter writes through. These tests drive the
// turn's interface directly and read the chunks the client would receive.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { resolveToolApproval } from "../tool-approvals.js";
import {
  createAgentTurn,
  formatTurnUsage,
  streamAgentTurn,
} from "./agent-turn.js";

const collect = (options = {}) => {
  const chunks = [];
  const turn = createAgentTurn({
    provider: "grok",
    label: "Grok Build",
    model: "grok-4",
    projectPath: "/proj",
    responseMessageMetadata: { createdAt: "t0", model: "grok-4" },
    writer: { merge: vi.fn(), write: (chunk) => chunks.push(chunk) },
    ...options,
  });
  return { chunks, turn };
};

const types = (chunks) => chunks.map((chunk) => chunk.type);

const readChunks = async (response) => {
  assert.equal(response.status, 200);
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
};

// ── prose ─────────────────────────────────────────────────────────────

test("auto-id prose coalesces deltas into one part and switches kinds cleanly", () => {
  vi.useFakeTimers();
  try {
    const { chunks, turn } = collect();
    turn.text("Hel");
    turn.text("lo");
    assert.deepEqual(chunks, [], "deltas are buffered briefly");
    vi.advanceTimersByTime(50);
    assert.deepEqual(types(chunks), ["text-start", "text-delta"]);
    assert.equal(chunks[1].delta, "Hello");

    turn.reasoning("hmm");
    vi.advanceTimersByTime(50);
    assert.deepEqual(types(chunks).slice(2), [
      "text-end",
      "reasoning-start",
      "reasoning-delta",
    ]);

    turn.text("again");
    turn.closeText();
    assert.deepEqual(types(chunks).slice(5), [
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ]);
    assert.notEqual(chunks[0].id, chunks[6].id, "a new part after the switch");
  } finally {
    vi.useRealTimers();
  }
});

test("explicit-id prose writes immediately, ends on request, and stays ended", () => {
  const { chunks, turn } = collect();
  turn.text("a", "item-1");
  turn.reasoning("b", "item-2");
  turn.text("c", "item-1");
  turn.endText("item-1");
  turn.text("late", "item-1");
  turn.endText("item-2", "reasoning");

  assert.deepEqual(
    chunks.map((chunk) => [chunk.type, chunk.id]),
    [
      ["text-start", "item-1"],
      ["text-delta", "item-1"],
      ["reasoning-start", "item-2"],
      ["reasoning-delta", "item-2"],
      ["text-delta", "item-1"],
      ["text-end", "item-1"],
      ["reasoning-end", "item-2"],
    ],
  );
  assert.equal(turn.hasEndedText("item-1"), true);
});

test("the output cap truncates, ends the part, and says so once", () => {
  const { chunks, turn } = collect({ maxTextChars: 5 });
  turn.text("1234567", "p");
  turn.text("more", "p");
  assert.equal(turn.textLimited, true);
  assert.equal(chunks.find((c) => c.type === "text-delta").delta, "12345");
  const notice = chunks.filter((c) => c.id === "grok-output-limit");
  assert.deepEqual(types(notice), ["text-start", "text-delta", "text-end"]);
  assert.match(notice[1].delta, /Grok Build output stopped after 5 characters/);
  assert.equal(
    chunks.filter((c) => c.type === "text-delta").length,
    2,
    "nothing after the cap",
  );
});

// ── tools ─────────────────────────────────────────────────────────────

test("a tool starts once, completes once, and ends the prose it interrupts", () => {
  vi.useFakeTimers();
  try {
    const { chunks, turn } = collect();
    turn.text("before");
    assert.equal(
      turn.toolStart({
        input: { command: "ls" },
        title: "Command",
        toolCallId: "call-1",
        toolName: "runCommand",
      }),
      true,
    );
    assert.equal(
      turn.toolStart({ toolCallId: "call-1", toolName: "x" }),
      false,
    );
    assert.equal(turn.toolOutput("call-1", { output: "ok" }), true);
    assert.equal(turn.toolError("call-1", "late"), false);

    assert.deepEqual(types(chunks), [
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
    ]);
    assert.deepEqual(chunks[4], {
      dynamic: true,
      input: { command: "ls" },
      providerExecuted: true,
      title: "Command",
      toolCallId: "call-1",
      toolMetadata: { kind: "command" },
      toolName: "runCommand",
      type: "tool-input-available",
    });
    assert.deepEqual(chunks[3].toolMetadata, { kind: "command" });
    assert.equal(turn.toolStart({ toolCallId: "", toolName: "x" }), false);
  } finally {
    vi.useRealTimers();
  }
});

test("a tool is stamped with the kind its adapter passes, else its name's", () => {
  const { chunks, turn } = collect();
  turn.toolStart({ kind: "write", toolCallId: "a", toolName: "patchFiles" });
  turn.toolStart({ toolCallId: "b", toolName: "Read" });
  turn.toolStart({ kind: "nonsense", toolCallId: "c", toolName: "Grep" });
  turn.toolStart({ toolCallId: "d", toolName: "mcp__github__list_issues" });
  turn.toolStart({ toolCallId: "e", toolName: "somethingElse" });

  const kinds = Object.fromEntries(
    chunks
      .filter((chunk) => chunk.type === "tool-input-available")
      .map((chunk) => [chunk.toolCallId, chunk.toolMetadata?.kind ?? null]),
  );
  assert.deepEqual(kinds, {
    a: "write",
    b: "read",
    c: "search",
    d: "mcp",
    e: null,
  });
  assert.equal(
    "toolMetadata" in chunks.find((chunk) => chunk.toolCallId === "e"),
    false,
    "a tool of no known kind carries no metadata",
  );
});

test("tools in a merged stream are stamped with their kind", async () => {
  const merged = [];
  const turn = createAgentTurn({
    provider: "anthropic",
    writer: {
      merge: (stream) => merged.push(stream),
      write: () => {},
    },
  });
  turn.merge(
    new ReadableStream({
      start(controller) {
        for (const chunk of [
          { id: "t", type: "text-start" },
          { toolCallId: "1", toolName: "Bash", type: "tool-input-start" },
          {
            input: { command: "ls" },
            toolCallId: "1",
            toolName: "Bash",
            type: "tool-input-available",
          },
          {
            toolCallId: "2",
            toolMetadata: { kind: "read", source: "sdk" },
            toolName: "Bash",
            type: "tool-input-start",
          },
          { toolCallId: "3", toolName: "Unknown", type: "tool-input-start" },
          { output: "ok", toolCallId: "1", type: "tool-output-available" },
        ]) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  );

  const chunks = [];
  for await (const chunk of merged[0]) {
    chunks.push(chunk);
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.toolMetadata ?? null),
    [
      null,
      { kind: "command" },
      { kind: "command" },
      { kind: "read", source: "sdk" },
      null,
      null,
    ],
  );
});

test("an approval stamps the tool it shows", async () => {
  const { chunks, turn } = collect();
  const controller = new AbortController();
  const pending = turn
    .approval({
      kind: "question",
      signal: controller.signal,
      toolCallId: "q",
      toolName: "ask-user-question",
    })
    .catch(() => {});
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === "tool-input-available").toolMetadata,
    { kind: "question" },
  );
  controller.abort();
  await pending;
});

test("a failed tool reports its error text with a label fallback", () => {
  const { chunks, turn } = collect();
  turn.toolStart({ toolCallId: "c", toolName: "readFile" });
  turn.toolError("c");
  assert.equal(chunks.at(-1).errorText, "Grok Build tool failed.");
});

// ── approvals ─────────────────────────────────────────────────────────

test("an approval shows the tool, carries the provider-scoped id, and resolves with the answer", async () => {
  const { chunks, turn } = collect();
  const pending = turn.approval({
    input: { command: "rm -rf build" },
    title: "Command",
    toolCallId: "call-9",
    toolName: "runCommand",
  });
  const request = chunks.find((c) => c.type === "tool-approval-request");
  assert.deepEqual(request, {
    approvalId: "grok:call-9",
    toolCallId: "call-9",
    type: "tool-approval-request",
  });
  assert.deepEqual(types(chunks).slice(0, 2), [
    "tool-input-start",
    "tool-input-available",
  ]);

  const outcome = await resolveToolApproval({
    approved: true,
    id: "grok:call-9",
    reason: null,
    scope: "session",
  });
  assert.deepEqual(outcome, { handled: true, provider: "grok", status: "ok" });
  assert.deepEqual(await pending, {
    approved: true,
    id: "grok:call-9",
    reason: null,
    scope: "session",
  });
});

test("an approval is refused when its signal aborts", async () => {
  const controller = new AbortController();
  const { turn } = collect();
  const pending = turn.approval({
    signal: controller.signal,
    toolCallId: "call-2",
    toolName: "writeFile",
  });
  controller.abort();
  const response = await pending;
  assert.equal(response.approved, false);
  assert.equal(response.reason, "Permission request was cancelled.");
});

// ── plans, compaction, metadata ───────────────────────────────────────

test("plans are found in nested payloads and todo-style tools", () => {
  const { chunks, turn } = collect();
  assert.equal(turn.todos({ explanation: "why", plan: [{ step: "a" }] }), true);
  assert.equal(turn.todos({ nothing: true }), false);
  assert.equal(
    turn.todosFromTool({ name: "update_plan", arguments: '{"todos":[1]}' }),
    true,
  );
  assert.equal(turn.todosFromTool({ name: "shell" }), false);
  assert.deepEqual(chunks[0], {
    data: { explanation: "why", todos: [{ step: "a" }] },
    id: "todos",
    type: "data-todos",
  });
  assert.deepEqual(chunks[1].data, { explanation: null, todos: [1] });
});

test("context compaction is one data part per id", () => {
  const { chunks, turn } = collect();
  assert.equal(turn.compaction("c1", "compacting"), true);
  assert.equal(turn.compaction("c1", "compacted"), true);
  assert.equal(turn.compaction("", "compacted"), false);
  assert.deepEqual(chunks, [
    {
      data: { state: "compacting" },
      id: "c1",
      type: "data-context-compaction",
    },
    { data: { state: "compacted" }, id: "c1", type: "data-context-compaction" },
  ]);
});

test("session identity is stamped once and carried by later metadata", () => {
  const { chunks, turn } = collect({ modelSpeed: "fast" });
  turn.session("sess-1");
  turn.session("sess-1");
  turn.session("  ");
  turn.usage(
    {
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 1,
      cacheReadTokens: 3,
    },
    200_000,
  );

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].messageMetadata, {
    createdAt: "t0",
    model: "grok-4",
    remoteConversationId: "sess-1",
    remoteConversationModel: "grok-4",
    remoteConversationModelSpeed: "fast",
    remoteConversationProjectPath: "/proj",
  });
  assert.equal(chunks[1].messageMetadata.contextWindow, 200_000);
  assert.deepEqual(chunks[1].messageMetadata.usage, {
    cachedInputTokens: 3,
    inputTokenDetails: { cacheReadTokens: 3 },
    inputTokens: 10,
    outputTokenDetails: { reasoningTokens: 1 },
    outputTokens: 4,
    reasoningTokens: 1,
  });
});

test("usage formatting passes an AI SDK usage object through and drops junk", () => {
  const sdkUsage = { inputTokens: { total: 1 }, outputTokens: { total: 2 } };
  assert.equal(formatTurnUsage(sdkUsage), sdkUsage);
  assert.equal(formatTurnUsage(null), null);
  assert.deepEqual(formatTurnUsage({ inputTokens: 1, outputTokens: 2 }), {
    inputTokens: 1,
    outputTokens: 2,
  });
});

// ── the stream ────────────────────────────────────────────────────────

test("streamAgentTurn writes request metadata first, closes parts, and formats errors", async () => {
  const response = streamAgentTurn({
    provider: "opencode",
    label: "OpenCode",
    messages: [],
    model: "m",
    projectPath: "/p",
    responseMessageMetadata: { createdAt: "t0" },
    execute: async (turn) => {
      turn.text("hi", "x");
      throw new Error("boom");
    },
  });
  const chunks = await readChunks(response);
  assert.deepEqual(types(chunks).slice(0, 3), [
    "message-metadata",
    "text-start",
    "text-delta",
  ]);
  assert.deepEqual(chunks[0].messageMetadata, { createdAt: "t0" });
  assert.ok(types(chunks).includes("text-end"), "open parts are closed");
  assert.equal(chunks.find((c) => c.type === "error").errorText, "boom");
});

test("streamAgentTurn drops an error raised after the client aborted", async () => {
  const controller = new AbortController();
  const response = streamAgentTurn({
    abortSignal: controller.signal,
    provider: "cursor",
    messages: [],
    execute: async () => {
      controller.abort();
      throw new Error("ignored");
    },
  });
  const chunks = await readChunks(response);
  assert.equal(
    chunks.some((c) => c.type === "error"),
    false,
  );
});
