import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runAntigravityPrompt", () => {
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

    vi.doMock("./antigravity-cli.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        getAntigravityCliSpawnErrorMessage: (err) =>
          err?.message || "spawn error",
        resolveAntigravityCliLaunch: vi.fn(async () => ({
          argsPrefix: [],
          command: "agy",
          shell: false,
        })),
        resolveAntigravityEffort: vi.fn(() => null),
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("adds --print-timeout when timeoutMs is provided", async () => {
    const { runAntigravityPrompt } = await import("./generate-text.js");

    const promptPromise = runAntigravityPrompt({
      model: "gemini-3.8-flash",
      projectPath: "D:/project",
      prompt: "Hello",
      timeoutMs: 30000,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spawnCalls.length).toBe(1);
    const { args } = spawnCalls[0];
    expect(args).toContain("--print-timeout");
    expect(args).toContain("30s");

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: { response: "Hi there!", status: "SUCCESS" },
      })}\n`,
    );
    fakeChild.emit("close", 0);

    const result = await promptPromise;
    expect(result).toBe("Hi there!");
  });

  it("pipes prompt over stdin with --input-format stream-json when prompt exceeds limit", async () => {
    const { runAntigravityPrompt } = await import("./generate-text.js");

    let stdinData = "";
    fakeChild.stdin = new PassThrough();
    fakeChild.stdin.on("data", (chunk) => {
      stdinData += chunk.toString();
    });

    const largePrompt = "A".repeat(35000);
    const promptPromise = runAntigravityPrompt({
      model: "gemini-3.8-flash",
      projectPath: "D:/project",
      prompt: largePrompt,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spawnCalls.length).toBe(1);
    const { args, options } = spawnCalls[0];
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).not.toContain("-p");
    expect(options.stdio[0]).toBe("pipe");

    const parsedStdin = JSON.parse(stdinData.trim());
    expect(parsedStdin).toEqual({
      event: "user",
      message: { content: largePrompt },
    });

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: { response: "Summary", status: "SUCCESS" },
      })}\n`,
    );
    fakeChild.emit("close", 0);

    const result = await promptPromise;
    expect(result).toBe("Summary");
  });

  it("handles non-SUCCESS status in result event", async () => {
    const { runAntigravityPrompt } = await import("./generate-text.js");

    const promptPromise = runAntigravityPrompt({
      model: "gemini-3.8-flash",
      projectPath: "D:/project",
      prompt: "Hello",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: {
          error: { message: "Quota exceeded" },
          status: "ERROR",
        },
      })}\n`,
    );
    fakeChild.emit("close", 0);

    await expect(promptPromise).rejects.toThrow("Quota exceeded");
  });

  it("rejects on process timeout", async () => {
    const { runAntigravityPrompt } = await import("./generate-text.js");

    const promptPromise = runAntigravityPrompt({
      model: "gemini-3.8-flash",
      projectPath: "D:/project",
      prompt: "Hello",
      timeoutMs: 50,
    });

    await expect(promptPromise).rejects.toThrow(/timed out after 50ms/);
  });
});
