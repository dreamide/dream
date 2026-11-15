import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAgentCliExitMessage,
  MAX_AGENT_CLI_STDERR_CHARS,
  runAgentCli,
} from "./agent-cli-run.js";

const FAKE_CLI = fileURLToPath(
  new URL("./test-fixtures/fake-agent-cli.js", import.meta.url),
);

const fakeLaunch = (mode) => ({
  argsPrefix: [FAKE_CLI, mode],
  command: process.execPath,
  shell: false,
});

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const waitForExit = async (pids) => {
  const deadline = Date.now() + 5000;
  while (pids.some(isRunning) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids.filter(isRunning);
};

// Runs the hanging fake, handing its pids to `onPids` once it reports them.
const runHanging = (options, onPids = () => {}) =>
  runAgentCli({
    label: "Fake",
    launch: fakeLaunch("hang"),
    onEvent: (event) => {
      if (Array.isArray(event.pids)) onPids(event.pids);
    },
    ...options,
  });

describe("runAgentCli", () => {
  it("writes stdin and hands each JSON stdout line to onEvent", async () => {
    const events = [];
    await runAgentCli({
      label: "Fake",
      launch: fakeLaunch("echo"),
      onEvent: (event) => events.push(event),
      stdin: "hello agent",
    });
    expect(events).toEqual([{ text: "hello agent" }]);
  });

  it("rejects a non-zero exit with the stderr tail", async () => {
    await expect(
      runAgentCli({ label: "Fake", launch: fakeLaunch("fail") }),
    ).rejects.toThrow("model quota exceeded");
  });

  it("rejects a silent non-zero exit with the exit message", async () => {
    await expect(
      runAgentCli({ label: "Fake", launch: fakeLaunch("silent") }),
    ).rejects.toThrow(formatAgentCliExitMessage("Fake", 4));
    expect(formatAgentCliExitMessage("Fake", 4)).toBe(
      "Fake CLI exited with code 4.",
    );
  });

  it("keeps only the last 64,000 characters of stderr", async () => {
    const error = await runAgentCli({
      label: "Fake",
      launch: fakeLaunch("flood"),
    }).catch((caught) => caught);
    expect(error.message).toHaveLength(MAX_AGENT_CLI_STDERR_CHARS);
    expect(error.message.endsWith("END")).toBe(true);
  });

  it("words a missing command through spawnErrorMessage", async () => {
    await expect(
      runAgentCli({
        label: "Fake",
        launch: {
          argsPrefix: [],
          command: "dream-no-such-agent-cli",
          shell: false,
        },
        spawnErrorMessage: (error) =>
          error?.code === "ENOENT" ? "Fake CLI is not installed." : "other",
      }),
    ).rejects.toThrow("Fake CLI is not installed.");
  });

  it("rejects an error thrown by onEvent after a clean exit", async () => {
    await expect(
      runAgentCli({
        label: "Fake",
        launch: fakeLaunch("echo"),
        onEvent: () => {
          throw new Error("result status ERROR");
        },
        stdin: "",
      }),
    ).rejects.toThrow("result status ERROR");
  });

  it("stops the process tree and rejects after the timeout", async () => {
    let pids = [];
    const error = await runHanging({ timeoutMs: 3000 }, (reported) => {
      pids = reported;
    }).catch((caught) => caught);

    expect(error.message).toBe("Fake request timed out after 3000ms.");
    expect(pids).toHaveLength(2);
    expect(await waitForExit(pids)).toEqual([]);
  }, 15_000);

  it("stops the process tree and rejects when the signal aborts", async () => {
    const controller = new AbortController();
    let pids = [];
    const error = await runHanging(
      { signal: controller.signal },
      (reported) => {
        pids = reported;
        controller.abort();
      },
    ).catch((caught) => caught);

    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("Fake request was stopped.");
    expect(pids).toHaveLength(2);
    expect(await waitForExit(pids)).toEqual([]);
  }, 15_000);

  it("does not spawn when the signal has already aborted", async () => {
    const onEvent = vi.fn();
    await expect(
      runAgentCli({
        label: "Fake",
        launch: fakeLaunch("echo"),
        onEvent,
        signal: AbortSignal.abort(),
        stdin: "unused",
      }),
    ).rejects.toThrow("Fake request was stopped.");
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("one-shot runners on runAgentCli", () => {
  afterEach(() => {
    vi.doUnmock("./cursor-cli.js");
    vi.resetModules();
  });

  it("stops a hung Cursor one-shot after timeoutMs", async () => {
    vi.doMock("./cursor-cli.js", async (importOriginal) => ({
      ...(await importOriginal()),
      resolveCursorCliLaunch: async () => fakeLaunch("hang"),
    }));
    const { runCursorPrompt } = await import("./generate-text.js");

    await expect(
      runCursorPrompt({
        model: "auto",
        projectPath: process.cwd(),
        prompt: "Title this",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Cursor request timed out after 1000ms.");
  }, 15_000);
});
