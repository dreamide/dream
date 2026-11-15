// One agent CLI process run to completion: spawn it from a resolved launch,
// write its stdin, hand each JSON line of stdout to the caller, keep a
// bounded tail of stderr, and settle once. It rejects on a spawn failure
// (worded by the caller), a non-zero exit (the tail, or one exit message), a
// timeout, or a stop through `signal`; the last two stop the whole process
// tree. Long-lived JSON-RPC processes (ACP, Codex app server) keep their own
// lifetime.
import { spawn } from "node:child_process";
import { stopChildProcess } from "../../process-tree.js";

export const MAX_AGENT_CLI_STDERR_CHARS = 64_000;

export const formatAgentCliExitMessage = (label, code) =>
  `${label} CLI exited with code ${code}.`;

/** The rejection of a run stopped through its signal. */
export const createAgentCliStopError = (label) => {
  const error = new Error(`${label} request was stopped.`);
  error.name = "AbortError";
  return error;
};

export const createAgentCliTimeoutError = (label, timeoutMs) =>
  new Error(`${label} request timed out after ${timeoutMs}ms.`);

/**
 * Runs `launch` (from a provider's launch resolver: `command`, `argsPrefix`,
 * `shell`) with `args` and resolves when it exits with code 0.
 *
 * `onEvent(event, run)` receives each parsed JSON line of stdout; a line that
 * is not JSON joins the error tail, and so does `run.reportError(detail)`.
 * An error thrown by `onEvent` is kept, the rest of the output is still read,
 * and the run rejects with the first such error whatever the exit code.
 * `stdin` text is written and closed; without it stdin is not opened.
 */
export const runAgentCli = ({
  label,
  launch,
  args = [],
  cwd,
  env = process.env,
  stdin,
  onEvent = () => {},
  spawnErrorMessage = (error) =>
    error instanceof Error ? error.message : `${label} CLI request failed.`,
  timeoutMs,
  signal,
}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAgentCliStopError(label));
      return;
    }

    let tail = "";
    let stdoutBuffer = "";
    let eventError = null;
    // Set once the outcome is known; a stop decides it before the exit.
    let decided = false;
    let timer = null;
    let child;

    const appendTail = (text) => {
      tail = `${tail}${text}`.slice(-MAX_AGENT_CLI_STDERR_CHARS);
    };
    const run = {
      reportError: (detail) => {
        if (detail) {
          appendTail(`${detail}\n`);
        }
      },
    };

    const decide = () => {
      if (decided) {
        return false;
      }
      decided = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      return true;
    };

    const settle = (error) => {
      if (!decide()) {
        return;
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    // Stops the process tree, then rejects with `error`; output and the exit
    // after this are ignored.
    const stop = (error) => {
      if (!decide()) {
        return;
      }
      void stopChildProcess(child)
        .catch(() => {})
        .then(() => reject(error));
    };

    function onAbort() {
      stop(createAgentCliStopError(label));
    }

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || decided) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        appendTail(`${trimmed}\n`);
        return;
      }
      try {
        onEvent(event, run);
      } catch (error) {
        eventError ??=
          error instanceof Error ? error : new Error(String(error));
      }
    };

    try {
      child = spawn(launch.command, [...(launch.argsPrefix ?? []), ...args], {
        cwd,
        env,
        shell: launch.shell ?? false,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle(new Error(spawnErrorMessage(error)));
      return;
    }

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        stop(createAgentCliTimeoutError(label, timeoutMs));
      }, timeoutMs);
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    if (stdin !== undefined && child.stdin) {
      // The CLI may exit before reading stdin; its exit reports why.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
    });
    child.stderr.on("data", appendTail);
    child.on("error", (error) => {
      settle(new Error(spawnErrorMessage(error)));
    });
    child.on("close", (code) => {
      consumeLine(stdoutBuffer);
      stdoutBuffer = "";
      if (eventError) {
        settle(eventError);
      } else if (code === 0) {
        settle();
      } else {
        settle(
          new Error(tail.trim() || formatAgentCliExitMessage(label, code)),
        );
      }
    });
  });
