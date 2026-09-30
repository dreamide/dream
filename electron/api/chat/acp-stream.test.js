// The ACP translator, driven through a fake adapter and connection: ACP
// session updates in, turn chunks out. This is the table every ACP
// provider (Cursor, Grok) is judged against.
import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveToolApproval } from "../tool-approvals.js";
import { streamAcpResponse } from "./acp-stream.js";

const readChunks = async (response) =>
  (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));

/**
 * A fake ACP agent. `script(session)` runs after session/prompt is called
 * and drives notifications and requests through the connection.
 */
const createFakeAdapter = ({
  loadSession = false,
  promptResult = {},
  script,
} = {}) => {
  const requests = [];
  const connection = {
    close: () => {},
    notify: (method, params) => requests.push(["notify", method, params]),
    onNotification: null,
    onRequest: null,
    request: async (method, params) => {
      requests.push(["request", method, params]);
      if (method === "initialize") {
        return { agentCapabilities: { loadSession } };
      }
      if (method === "session/load") {
        return { modes: {} };
      }
      if (method === "session/new") {
        return { sessionId: "sess-1" };
      }
      if (method === "session/prompt") {
        await script?.(connection, params.sessionId);
        return promptResult;
      }
      return {};
    },
  };

  return {
    adapter: {
      provider: "grok",
      label: "Grok Build",
      authenticate: async () => {},
      spawn: async () => connection,
      getUsage: (result) => result?.usage ?? null,
    },
    requests,
  };
};

const request = {
  messages: [
    { id: "u1", parts: [{ text: "hello", type: "text" }], role: "user" },
  ],
  model: "grok-4",
  permissionMode: "ask",
  projectPath: process.cwd(),
  responseMessageMetadata: { createdAt: "t0", model: "grok-4" },
};

const update = (connection, sessionId, payload) =>
  connection.onNotification("session/update", {
    sessionId,
    update: payload,
  });

test("text, thoughts, plans and tool calls become turn chunks", async () => {
  const { adapter } = createFakeAdapter({
    promptResult: {
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
      },
    },
    script: async (connection, sessionId) => {
      update(connection, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "thinking" },
      });
      update(connection, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Reading " },
      });
      update(connection, sessionId, {
        sessionUpdate: "plan",
        entries: [{ content: "step 1", status: "pending" }],
      });
      update(connection, sessionId, {
        sessionUpdate: "tool_call",
        kind: "read",
        rawInput: { file_path: "src/a.ts" },
        status: "in_progress",
        title: "Read file",
        toolCallId: "tc-1",
      });
      update(connection, sessionId, {
        sessionUpdate: "tool_call_update",
        content: [
          { content: { text: "file body", type: "text" }, type: "content" },
        ],
        status: "completed",
        toolCallId: "tc-1",
      });
      update(connection, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: "done" },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    },
  });

  const chunks = await readChunks(
    await streamAcpResponse({ ...request, adapter }),
  );
  const types = chunks.map((c) => c.type);
  assert.equal(
    chunks.some((c) => c.type === "error"),
    false,
  );

  const reasoning = chunks.find((c) => c.type === "reasoning-delta");
  assert.equal(reasoning.delta, "thinking");
  const toolStart = chunks.find((c) => c.type === "tool-input-available");
  assert.deepEqual(toolStart.input, {
    file_path: "src/a.ts",
    filePath: "src/a.ts",
    path: "src/a.ts",
  });
  assert.equal(toolStart.toolName, "readFile");
  assert.equal(
    chunks.find((c) => c.type === "tool-output-available").output,
    "file body",
  );
  assert.deepEqual(chunks.find((c) => c.type === "data-todos").data.todos, [
    { content: "step 1", status: "pending" },
  ]);

  // Prose before the tool is ended before the tool starts, and resumes in
  // a new part afterwards.
  const firstTextEnd = types.indexOf("text-end");
  const toolInputStart = types.indexOf("tool-input-start");
  assert.ok(firstTextEnd < toolInputStart);
  const textDeltas = chunks.filter((c) => c.type === "text-delta");
  assert.deepEqual(
    textDeltas.map((c) => c.delta),
    ["Reading ", "done"],
  );
  assert.notEqual(textDeltas[0].id, textDeltas[1].id);

  const sessionMetadata = chunks.find(
    (c) =>
      c.type === "message-metadata" && c.messageMetadata.remoteConversationId,
  );
  assert.equal(sessionMetadata.messageMetadata.remoteConversationId, "sess-1");
  const usage = chunks.findLast((c) => c.type === "message-metadata");
  assert.equal(usage.messageMetadata.usage.inputTokens, 5);
});

test("a permission request in ask mode goes to the user and picks the matching option", async () => {
  const { adapter, requests } = createFakeAdapter({
    script: async (connection, sessionId) => {
      const answer = connection.onRequest("session/request_permission", {
        options: [
          { kind: "allow_once", optionId: "once" },
          { kind: "allow_always", optionId: "always" },
          { kind: "reject_once", optionId: "no" },
        ],
        sessionId,
        toolCall: {
          kind: "execute",
          rawInput: { command: "pnpm test" },
          title: "Run tests",
          toolCallId: "tc-2",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await resolveToolApproval({
        approved: true,
        id: "grok:tc-2",
        reason: null,
        scope: "session",
      });
      requests.push(["answer", await answer]);
    },
  });

  const chunks = await readChunks(
    await streamAcpResponse({ ...request, adapter }),
  );
  const approval = chunks.find((c) => c.type === "tool-approval-request");
  assert.deepEqual(approval, {
    approvalId: "grok:tc-2",
    toolCallId: "tc-2",
    type: "tool-approval-request",
  });
  assert.equal(
    chunks.find((c) => c.type === "tool-input-available").input.command,
    "pnpm test",
  );
  assert.deepEqual(requests.find((r) => r[0] === "answer")[1], {
    outcome: { optionId: "always", outcome: "selected" },
  });
});

test("full access auto-approves without asking", async () => {
  const { adapter, requests } = createFakeAdapter({
    script: async (connection, sessionId) => {
      requests.push([
        "answer",
        await connection.onRequest("session/request_permission", {
          options: [{ kind: "allow-once", optionId: "yes" }],
          sessionId,
          toolCall: { kind: "execute", toolCallId: "tc-3" },
        }),
      ]);
    },
  });

  const chunks = await readChunks(
    await streamAcpResponse({
      ...request,
      adapter,
      permissionMode: "full-access",
    }),
  );
  assert.equal(
    chunks.some((c) => c.type === "tool-approval-request"),
    false,
  );
  assert.deepEqual(requests.find((r) => r[0] === "answer")[1], {
    outcome: { optionId: "yes", outcome: "selected" },
  });
});

test("a failed tool call reports its error and a spawn failure reaches the client formatted", async () => {
  const { adapter } = createFakeAdapter({
    script: async (connection, sessionId) => {
      update(connection, sessionId, {
        sessionUpdate: "tool_call",
        kind: "edit",
        status: "failed",
        rawOutput: { message: "permission denied" },
        toolCallId: "tc-4",
      });
    },
  });
  const chunks = await readChunks(
    await streamAcpResponse({ ...request, adapter }),
  );
  assert.equal(
    chunks.find((c) => c.type === "tool-output-error").errorText,
    "permission denied",
  );

  const failing = {
    ...adapter,
    spawn: async () => {
      throw new Error("grok: not logged in");
    },
  };
  const failed = await readChunks(
    await streamAcpResponse({ ...request, adapter: failing }),
  );
  assert.equal(
    failed.find((c) => c.type === "error").errorText,
    "grok: not logged in",
  );
});

test("a resumable session is loaded and only the latest turn is sent", async () => {
  const { adapter, requests } = createFakeAdapter({ loadSession: true });
  await readChunks(
    await streamAcpResponse({
      ...request,
      adapter,
      messages: [
        ...request.messages,
        { id: "a1", parts: [{ text: "hi", type: "text" }], role: "assistant" },
        { id: "u2", parts: [{ text: "next", type: "text" }], role: "user" },
      ],
      remoteConversationId: "old-session",
      remoteConversationModel: "grok-4",
      remoteConversationProjectPath: request.projectPath,
      skillSlashCommand: "deploy",
    }),
  );
  const load = requests.find((r) => r[1] === "session/load");
  assert.equal(load[2].sessionId, "old-session");
  assert.equal(
    requests.some((r) => r[1] === "session/new"),
    false,
  );
  const prompt = requests.find((r) => r[1] === "session/prompt")[2].prompt[0]
    .text;
  assert.ok(prompt.startsWith("/deploy "), "the skill becomes a slash prefix");
  assert.ok(
    !prompt.includes("Conversation transcript"),
    "no full transcript on resume",
  );
});
