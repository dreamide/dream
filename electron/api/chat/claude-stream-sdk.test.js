import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCode, getSessionInfo } from "ai-sdk-provider-claude-code";
import { beforeEach, test, vi } from "vitest";
import { configureHostDataDirectory } from "../../host/host-paths.js";
import { turnObservers } from "./agent-turn.js";
import { streamClaudeResponse } from "./claude-stream.js";
import { executeAgentTurn } from "./turn-execution.js";
import { createTurnRegistry } from "./turn-registry.js";

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(),
  getSessionInfo: vi.fn(),
}));
vi.mock("../shared/cli.js", () => ({
  resolveCliCommandPath: vi.fn().mockResolvedValue(null),
}));

const usage = {
  inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: 0 },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};
let calls;
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  claudeCode.mockReturnValue({
    specificationVersion: "v4",
    provider: "claude-code",
    modelId: "haiku",
    supportedUrls: {},
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Hello" },
              { type: "text-end", id: "text-1" },
              {
                type: "tool-call",
                toolCallId: "tool-1",
                toolName: "Read",
                input: '{"file_path":"missing.txt"}',
                providerExecuted: true,
                dynamic: true,
              },
              {
                type: "tool-result",
                toolCallId: "tool-1",
                toolName: "Read",
                result: "File not found",
                isError: true,
                providerExecuted: true,
                dynamic: true,
              },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "end_turn" },
                usage,
                providerMetadata: { "claude-code": { sessionId: "session-1" } },
              },
            ])
              controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
});

const request = {
  agentMode: "agent",
  claudePermissionMode: "ask-permissions",
  model: "haiku",
  projectPath: "/tmp/dream-sdk-test",
  projectReferencesPrompt: "Use the referenced project.",
  messages: [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
  ],
};

const readChunks = async (response) => {
  assert.equal(response.status, 200);
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
};

test("a provider network error releases the chat for another turn", async () => {
  const model = claudeCode.getMockImplementation()();
  let providerSignal;
  let saved;
  claudeCode.mockReturnValue({
    ...model,
    doStream: async (options) => {
      providerSignal = options.abortSignal;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: "Partial answer",
            });
            controller.enqueue({
              type: "error",
              error: new Error("Network connection lost"),
            });
            // The provider reports the failure but never closes its stream.
          },
        }),
      };
    },
  });
  const turns = createTurnRegistry();
  const response = await turns.start({
    chatId: "network-error",
    run: (abortSignal) =>
      executeAgentTurn(
        {
          catalog: {
            saveTranscript: async (_chatId, messages) => {
              saved = messages;
              return true;
            },
          },
          chatId: "network-error",
          requestMessages: request.messages,
        },
        () => streamClaudeResponse({ ...request, abortSignal }),
      ),
  });
  const chunks = await readChunks(response);
  assert.equal(
    chunks.find((part) => part.type === "error").errorText,
    "Network connection lost",
  );
  assert.equal(turns.isRunning("network-error"), false);
  assert.equal(providerSignal.aborted, true);
  assert.equal(
    saved.at(-1).parts.find((part) => part.type === "text").text,
    "Partial answer",
  );
  assert.ok(saved.at(-1).metadata.completedAt);
  claudeCode.mockReturnValue(model);
  await readChunks(
    await turns.start({
      chatId: "network-error",
      run: (abortSignal) => streamClaudeResponse({ ...request, abortSignal }),
    }),
  );
});

test("streams v4 text, tool failures, session metadata and usage through the real AI SDK", async () => {
  const chunks = await readChunks(await streamClaudeResponse(request));
  assert.equal(
    chunks.some((part) => part.type === "error"),
    false,
  );
  assert.equal(
    chunks.find((part) => part.type === "text-delta").delta,
    "Hello",
  );
  assert.equal(
    chunks.find((part) => part.type === "tool-output-error").errorText,
    "File not found",
  );
  const metadata = chunks.find(
    (part) => part.type === "finish",
  ).messageMetadata;
  assert.equal(metadata.remoteConversationId, "session-1");
  assert.equal(metadata.usage.totalTokens, 15);
  assert.equal(metadata.usage.inputTokenDetails.cacheReadTokens, 4);
  assert.equal(metadata.usage.outputTokenDetails.reasoningTokens, 2);
  assert.deepEqual(calls[0].prompt[0], {
    role: "system",
    content: request.projectReferencesPrompt,
  });
});

test("resumes with only the latest turn and preserves image file inputs", async () => {
  getSessionInfo.mockResolvedValue({ sessionId: "session-1" });
  const chunks = await readChunks(
    await streamClaudeResponse({
      ...request,
      resumeSessionId: "session-1",
      messages: [
        ...request.messages,
        {
          id: "user-2",
          role: "user",
          parts: [
            { type: "text", text: "Inspect this image" },
            {
              type: "file",
              mediaType: "image/png",
              url: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(
    chunks.some((part) => part.type === "error"),
    false,
  );
  assert.equal(claudeCode.mock.calls[0][1].resume, "session-1");
  assert.equal(claudeCode.mock.calls[0][1].streamingInput, "auto");
  const users = calls[0].prompt.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  const image = users[0].content.find((part) => part.type === "file");
  assert.equal(image.mediaType, "image/png");
  assert.ok(image.data);
});

/** Runs a turn under a host observer that hears how it started. */
const observingStart = async (run) => {
  const starts = [];
  const observer = {
    onMessage: () => {},
    onSessionStart: (start) => {
      starts.push(start);
      return {};
    },
  };
  const chunks = await readChunks(await turnObservers.run(observer, run));
  return { chunks, starts };
};

const followUp = [
  ...request.messages,
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Hi" }],
  },
  { id: "user-2", role: "user", parts: [{ type: "text", text: "Next" }] },
];

test("a resumed turn reports so and carries the handoff with its references", async () => {
  getSessionInfo.mockResolvedValue({ sessionId: "session-1" });
  const { starts } = await observingStart(() =>
    streamClaudeResponse({
      ...request,
      messages: followUp,
      resumeSessionId: "session-1",
      sessionHandoff: "Missed while away.",
    }),
  );
  assert.deepEqual(starts, [{ resumed: true }]);
  assert.deepEqual(calls[0].prompt[0], {
    role: "system",
    content: "Use the referenced project.\n\nMissed while away.",
  });
});

test("a session Claude Code no longer has starts fresh with the full history, says why, and drops the handoff", async () => {
  getSessionInfo.mockResolvedValue(null);
  const { starts } = await observingStart(() =>
    streamClaudeResponse({
      ...request,
      messages: followUp,
      resumeSessionId: "session-1",
      sessionHandoff: "Missed while away.",
    }),
  );
  assert.deepEqual(starts, [
    { resumed: false, reason: "Claude Code no longer has the saved session." },
  ]);
  assert.equal(claudeCode.mock.calls[0][1].resume, undefined);
  assert.equal(
    calls[0].prompt.filter((message) => message.role === "user").length,
    2,
  );
  assert.deepEqual(calls[0].prompt[0], {
    role: "system",
    content: "Use the referenced project.",
  });
});

test("stopping the turn aborts the Claude query and ends the stream cleanly", async () => {
  // A model that never finishes on its own, like an agent mid-task: only an
  // abort ends it (the real provider interrupts its query the same way).
  claudeCode.mockReturnValue({
    specificationVersion: "v4",
    provider: "claude-code",
    modelId: "haiku",
    supportedUrls: {},
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: "Working",
            });
            const abort = () => controller.error(options.abortSignal.reason);
            if (options.abortSignal?.aborted) abort();
            else options.abortSignal?.addEventListener("abort", abort);
          },
        }),
      };
    },
  });

  const stop = new AbortController();
  const response = await streamClaudeResponse({
    ...request,
    abortSignal: stop.signal,
  });
  const reading = readChunks(response);
  await vi.waitFor(() => assert.equal(calls.length, 1));
  stop.abort();

  const chunks = await reading;
  assert.ok(calls[0].abortSignal, "the model received an abort signal");
  assert.equal(calls[0].abortSignal.aborted, true);
  assert.equal(
    chunks.some((part) => part.type === "error"),
    false,
  );
});

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const fileOf = (filename, mediaType, content) => ({
  type: "file",
  filename,
  mediaType,
  url: `data:${mediaType};base64,${Buffer.from(content).toString("base64")}`,
});
const xlsxMessage = {
  id: "user-2",
  role: "user",
  parts: [
    { type: "text", text: "how about this?" },
    fileOf("grid-stripe-integration.xlsx", XLSX_TYPE, "PK-spreadsheet"),
  ],
};
const promptText = (call) =>
  call.prompt
    .filter((message) => message.role === "user")
    .at(-1)
    .content.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
const savedPath = (text) => /Saved at: (.+)/.exec(text)?.[1];

const withHostDirectory = async (run) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "dream-claude-attachments-"),
  );
  configureHostDataDirectory(directory);
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
};

test("gives the agent a readable path to a file the provider cannot forward", async () => {
  await withHostDirectory(async () => {
    await readChunks(
      await streamClaudeResponse({
        ...request,
        chatId: "chat-1",
        messages: [xlsxMessage],
      }),
    );

    const text = promptText(calls[0]);
    assert.ok(text.includes("grid-stripe-integration.xlsx"));
    assert.equal(await fs.readFile(savedPath(text), "utf8"), "PK-spreadsheet");
    const { additionalDirectories } = claudeCode.mock.calls[0][1];
    assert.equal(additionalDirectories.length, 1);
    assert.ok(savedPath(text).startsWith(additionalDirectories[0]));
  });
});

test("a resumed follow-up can still reach an earlier attachment", async () => {
  await withHostDirectory(async () => {
    getSessionInfo.mockResolvedValue({ sessionId: "session-1" });
    await readChunks(
      await streamClaudeResponse({
        ...request,
        chatId: "chat-1",
        resumeSessionId: "session-1",
        messages: [
          xlsxMessage,
          { id: "assistant-1", role: "assistant", parts: [] },
          {
            id: "user-3",
            role: "user",
            parts: [{ type: "text", text: "now the second sheet" }],
          },
        ],
      }),
    );

    const text = promptText(calls[0]);
    assert.equal(
      calls[0].prompt.filter((message) => message.role === "user").length,
      1,
    );
    assert.equal(text.includes("Current turn attachments"), false);
    const listed = /grid-stripe-integration\.xlsx: (.+)/.exec(text)?.[1];
    assert.equal(await fs.readFile(listed, "utf8"), "PK-spreadsheet");
  });
});

test("a truncated text attachment points at the full file", async () => {
  await withHostDirectory(async () => {
    const csv = "a,b,c\n".repeat(20_000);
    await readChunks(
      await streamClaudeResponse({
        ...request,
        chatId: "chat-1",
        messages: [
          {
            id: "user-2",
            role: "user",
            parts: [fileOf("mrr-waterfall.csv", "text/csv", csv)],
          },
        ],
      }),
    );

    const text = promptText(calls[0]);
    assert.ok(text.includes("[File content truncated for prompt size.]"));
    assert.equal(await fs.readFile(savedPath(text), "utf8"), csv);
  });
});

test("says so when an attachment could not be saved", async () => {
  await withHostDirectory(async (directory) => {
    // A file where the attachments folder belongs makes every save fail.
    await fs.writeFile(path.join(directory, "dream.db.attachments"), "");
    await readChunks(
      await streamClaudeResponse({
        ...request,
        chatId: "chat-1",
        messages: [xlsxMessage],
      }),
    );

    const text = promptText(calls[0]);
    assert.ok(text.includes("Contents unavailable"));
    assert.equal(savedPath(text), undefined);
    assert.equal(claudeCode.mock.calls[0][1].additionalDirectories, undefined);
  });
});

test("an image-only turn gains no saved path or extra directory", async () => {
  await withHostDirectory(async () => {
    await readChunks(
      await streamClaudeResponse({
        ...request,
        chatId: "chat-1",
        messages: [
          {
            id: "user-2",
            role: "user",
            parts: [
              {
                type: "file",
                mediaType: "image/png",
                url: "data:image/png;base64,iVBORw0KGgo=",
              },
            ],
          },
        ],
      }),
    );

    assert.equal(savedPath(promptText(calls[0])), undefined);
    assert.equal(claudeCode.mock.calls[0][1].additionalDirectories, undefined);
  });
});
