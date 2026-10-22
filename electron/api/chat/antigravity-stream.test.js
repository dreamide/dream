import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readChunks = async (response) =>
  (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));

describe("streamAntigravityResponse", () => {
  let fakeChild;
  let spawnCalls = [];

  beforeEach(async () => {
    spawnCalls = [];
    fakeChild = new EventEmitter();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.kill = vi.fn();

    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        spawn: (command, args, options) => {
          spawnCalls.push({ args, command, options });
          return fakeChild;
        },
      };
    });

    vi.doMock("../providers/antigravity-cli.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        getAntigravityCliSpawnErrorMessage: (err) =>
          err?.message || "spawn error",
        resolveAntigravityCliLaunch: async () => ({
          argsPrefix: [],
          command: "agy",
          shell: false,
        }),
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("translates stream-json events to turn chunks", async () => {
    const { streamAntigravityResponse } = await import(
      "./antigravity-stream.js"
    );

    const responsePromise = streamAntigravityResponse({
      messages: [
        { id: "u1", parts: [{ text: "Fix bug", type: "text" }], role: "user" },
      ],
      model: "gemini-3.8-flash",
      permissionMode: "full-access",
      projectPath: "D:/project",
      reasoningEffort: "high",
    });

    // Feed events after microtask
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 1. init event
    fakeChild.stdout.write(
      `${JSON.stringify({
        conversation_id: "conv-123",
        event: "init",
      })}\n`,
    );

    // 2. agent_response with reasoning and text
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-123",
          state: "ACTIVE",
          step_index: 0,
          step_type: "agent_response",
          thought_delta: "Thinking about file changes...",
        },
      })}\n`,
    );

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-123",
          state: "ACTIVE",
          step_index: 0,
          step_type: "agent_response",
          text_delta: "I will edit the file.",
        },
      })}\n`,
    );

    // 3. tool call
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-123",
          state: "ACTIVE",
          step_index: 1,
          step_type: "tool",
          tool_info: {
            parameters: {
              Path: "src/index.ts",
              Replacement: "console.log('fixed');",
              Target: "console.log('broken');",
            },
            tool_name: "edit_file",
          },
        },
      })}\n`,
    );

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-123",
          state: "DONE",
          step_index: 1,
          step_type: "tool",
          tool_info: {
            output: "File updated successfully",
            tool_name: "edit_file",
          },
        },
      })}\n`,
    );

    // 4. result event with usage
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "SUCCESS",
          usage: {
            cache_read_tokens: 100,
            input_tokens: 500,
            output_tokens: 150,
            thinking_tokens: 80,
          },
        },
      })}\n`,
    );

    fakeChild.emit("close", 0);

    const response = await responsePromise;
    const chunks = await readChunks(response);

    // Assert spawned CLI arguments
    expect(spawnCalls.length).toBe(1);
    const { args } = spawnCalls[0];
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.8-flash");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("-p");

    // Assert turn chunks
    const reasoning = chunks.find((c) => c.type === "reasoning-delta");
    expect(reasoning?.delta).toBe("Thinking about file changes...");

    const text = chunks.find((c) => c.type === "text-delta");
    expect(text?.delta).toBe("I will edit the file.");

    const toolStart = chunks.find((c) => c.type === "tool-input-available");
    expect(toolStart).toBeDefined();
    expect(toolStart.toolName).toBe("writeFile");
    expect(toolStart.input.filePath).toBe("src/index.ts");
    expect(toolStart.input.old_string).toBe("console.log('broken');");
    expect(toolStart.input.new_string).toBe("console.log('fixed');");

    const toolOutput = chunks.find((c) => c.type === "tool-output-available");
    expect(toolOutput?.output).toBe("File updated successfully");

    const metadataChunk = chunks.find(
      (c) => c.type === "message-metadata" && c.messageMetadata?.usage,
    );
    expect(metadataChunk).toBeDefined();
    expect(metadataChunk.messageMetadata.usage.inputTokens).toBe(500);
    expect(metadataChunk.messageMetadata.usage.outputTokens).toBe(150);
  });

  it("handles tool errors properly", async () => {
    const { streamAntigravityResponse } = await import(
      "./antigravity-stream.js"
    );

    const responsePromise = streamAntigravityResponse({
      messages: [
        { id: "u1", parts: [{ text: "Run test", type: "text" }], role: "user" },
      ],
      permissionMode: "ask",
      projectPath: "D:/project",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_index: 1,
          step_type: "tool",
          tool_info: {
            parameters: { command: "invalid_command" },
            tool_name: "run_command",
          },
        },
      })}\n`,
    );

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ERROR",
          step_index: 1,
          step_type: "tool",
          tool_info: {
            error: "Command not found",
            tool_name: "run_command",
          },
        },
      })}\n`,
    );

    fakeChild.emit("close", 0);

    const response = await responsePromise;
    const chunks = await readChunks(response);

    const toolError = chunks.find((c) => c.type === "tool-output-error");
    expect(toolError).toBeDefined();
    expect(toolError.errorText).toBe("Command not found");
  });

  it("handles CLI exit errors cleanly", async () => {
    const { streamAntigravityResponse } = await import(
      "./antigravity-stream.js"
    );

    const responsePromise = streamAntigravityResponse({
      messages: [
        { id: "u1", parts: [{ text: "Hello", type: "text" }], role: "user" },
      ],
      projectPath: "D:/project",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    fakeChild.stderr.write("User authentication required. Run agy login.\n");
    fakeChild.emit("close", 1);

    const response = await responsePromise;
    const chunks = await readChunks(response);

    const errorChunk = chunks.find((c) => c.type === "error");
    expect(errorChunk).toBeDefined();
    expect(errorChunk.errorText).toContain("User authentication required");
  });

  it("handles session resumption with --conversation", async () => {
    const { streamAntigravityResponse } = await import(
      "./antigravity-stream.js"
    );

    const responsePromise = streamAntigravityResponse({
      messages: [
        { id: "u1", parts: [{ text: "Turn 1", type: "text" }], role: "user" },
        {
          id: "a1",
          parts: [{ text: "Response 1", type: "text" }],
          role: "assistant",
        },
        { id: "u2", parts: [{ text: "Turn 2", type: "text" }], role: "user" },
      ],
      model: "gemini-3.8-flash-low",
      projectPath: "D:/project",
      remoteConversationId: "conv-existing-456",
      remoteConversationModel: "gemini-3.8-flash-low",
      remoteConversationProjectPath: "D:/project",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    fakeChild.emit("close", 0);

    await responsePromise;

    expect(spawnCalls.length).toBe(1);
    const { args } = spawnCalls[0];
    expect(args).toContain("--conversation");
    expect(args).toContain("conv-existing-456");
    // Verify only the latest user message is passed
    const pIndex = args.indexOf("-p");
    expect(args[pIndex + 1]).toBe("Turn 2");
    expect(args[pIndex + 1]).not.toContain("Response 1");
    expect(args[pIndex + 1]).not.toContain("USER:");
  });

  it("omits --effort flag when model has built-in effort or does not support effort", async () => {
    const { streamAntigravityResponse } = await import(
      "./antigravity-stream.js"
    );

    const responsePromise = streamAntigravityResponse({
      messages: [
        { id: "u1", parts: [{ text: "Fix bug", type: "text" }], role: "user" },
      ],
      model: "gemini-3.8-flash-low",
      projectPath: "D:/project",
      reasoningEffort: "medium",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    fakeChild.emit("close", 0);
    await responsePromise;

    expect(spawnCalls.length).toBe(1);
    const { args } = spawnCalls[0];
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.8-flash-low");
    expect(args).not.toContain("--effort");
  });

  it("pipes prompt to stdin when launch requires shell or prompt is large", async () => {
    const { streamAntigravityResponse } = await import(
      "./antigravity-stream.js"
    );

    let writtenStdin = "";
    fakeChild.stdin = new PassThrough();
    fakeChild.stdin.on("data", (d) => {
      writtenStdin += d.toString();
    });

    const largePrompt = "A".repeat(9000);
    const responsePromise = streamAntigravityResponse({
      messages: [
        {
          id: "u1",
          parts: [{ text: largePrompt, type: "text" }],
          role: "user",
        },
      ],
      model: "gemini-3.8-flash",
      projectPath: "D:/project",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    fakeChild.emit("close", 0);
    await responsePromise;

    expect(spawnCalls.length).toBe(1);
    const { args, options } = spawnCalls[0];
    expect(args).not.toContain("-p");
    expect(options.stdio[0]).toBe("pipe");
    expect(writtenStdin).toBe(largePrompt);
  });
});
