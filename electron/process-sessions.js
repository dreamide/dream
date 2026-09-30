import { spawn as spawnProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { app } from "electron";
import { spawn as spawnPty } from "node-pty";
import { stopProcessTree } from "./process-tree.js";
import { createTerminalOutput } from "./terminal-output.js";
import { getDefaultTerminalShellPath } from "./terminal-shells.js";

function parseCommandParts(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const parts = matches.map((part) =>
    part.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"),
  );
  const command = parts[0];
  if (!command) {
    return null;
  }

  return {
    args: parts.slice(1),
    command,
  };
}

function formatShellCommand(command, args = []) {
  const trimmedCommand = typeof command === "string" ? command.trim() : "";
  if (!trimmedCommand) {
    return "";
  }

  const normalizedArgs = Array.isArray(args)
    ? args
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  const formattedCommand = /\s/.test(trimmedCommand)
    ? `"${trimmedCommand.replaceAll('"', '\\"')}"`
    : trimmedCommand;
  return [formattedCommand, ...normalizedArgs].join(" ");
}

function createTerminalStartupCommands(command) {
  const commands = [];
  if (typeof command === "string" && command.trim()) {
    commands.push(command.trim());
  }

  return commands;
}

function resolveTerminalCwd(cwd, { strict = false } = {}) {
  if (typeof cwd !== "string") {
    if (strict) {
      throw new Error("Terminal working directory does not exist.");
    }
    return app.getPath("home");
  }

  const trimmed = cwd.trim();
  if (!trimmed) {
    if (strict) {
      throw new Error("Terminal working directory does not exist.");
    }
    return app.getPath("home");
  }

  try {
    if (existsSync(trimmed) && statSync(trimmed).isDirectory()) {
      return trimmed;
    }
  } catch {
    // ignore and fall back
  }

  if (strict) {
    throw new Error("Terminal working directory does not exist.");
  }

  return app.getPath("home");
}

function buildTerminalShellCandidates(preferredShellPath) {
  // Login shells often reset to $HOME, which breaks project-scoped terminals.
  const defaultShellArgs = process.platform === "win32" ? [] : ["-i"];
  const candidates = [];
  const seen = new Set();

  const addCandidate = (rawValue, label) => {
    const parsed = parseCommandParts(rawValue);
    if (!parsed) {
      return;
    }

    const args = parsed.args.length > 0 ? parsed.args : defaultShellArgs;
    const key = `${parsed.command}\u0000${args.join("\u0000")}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({
      args,
      command: parsed.command,
      label,
    });
  };

  addCandidate(preferredShellPath, "configured shell");
  if (process.platform === "win32") {
    addCandidate(getDefaultTerminalShellPath(), "PowerShell fallback");
    addCandidate(process.env.SHELL, "SHELL environment");
    addCandidate("cmd.exe", "CMD fallback");
  } else if (process.platform === "darwin") {
    addCandidate(process.env.SHELL, "SHELL environment");
    addCandidate("/bin/zsh", "macOS zsh fallback");
    addCandidate("/bin/bash", "bash fallback");
    addCandidate("/bin/sh", "sh fallback");
  } else {
    addCandidate(process.env.SHELL, "SHELL environment");
    addCandidate("/bin/bash", "bash fallback");
    addCandidate("/bin/sh", "sh fallback");
  }

  return candidates;
}

function getPipeFallbackShell() {
  if (process.platform === "win32") {
    return {
      args: [],
      command: "powershell.exe",
      label: "PowerShell pipe fallback",
    };
  }

  if (existsSync("/bin/bash")) {
    return {
      args: ["--noprofile", "--norc", "-i"],
      command: "/bin/bash",
      label: "bash pipe fallback",
    };
  }

  return {
    args: ["-i"],
    command: "/bin/sh",
    label: "sh pipe fallback",
  };
}

export function createProcessSessionManager({ sendToRenderer }) {
  const terminalSessions = new Map();
  const terminalTransports = new Map();
  const terminalShells = new Map();
  const terminalOutputs = new Map();
  const terminalStartupTimers = new Map();

  function clearTerminalStartupTimer(sessionId) {
    clearTimeout(terminalStartupTimers.get(sessionId));
    terminalStartupTimers.delete(sessionId);
  }

  function writeTerminalStartupCommands(sessionId, commands, delayMs = 80) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return;
    }

    clearTerminalStartupTimer(sessionId);
    const session = terminalSessions.get(sessionId);
    const timer = setTimeout(() => {
      if (terminalStartupTimers.get(sessionId) === timer) {
        terminalStartupTimers.delete(sessionId);
      }
      if (!session || terminalSessions.get(sessionId) !== session) {
        return;
      }

      try {
        session.write(`${commands.join("\r")}\r`);
      } catch {
        // ignore write failures after session exits
      }
    }, delayMs);
    terminalStartupTimers.set(sessionId, timer);
  }

  async function stopTerminalSession(sessionId) {
    clearTerminalStartupTimer(sessionId);
    const session = terminalSessions.get(sessionId);
    const transport = terminalTransports.get(sessionId);
    const shell = terminalShells.get(sessionId);
    if (!session) {
      return;
    }

    terminalOutputs.get(sessionId)?.dispose();
    terminalOutputs.delete(sessionId);
    terminalSessions.delete(sessionId);
    terminalTransports.delete(sessionId);
    terminalShells.delete(sessionId);

    await stopProcessTree(session.pid);
    try {
      await Promise.resolve(session.kill());
    } catch {
      // ignore stop failures
    }

    sendToRenderer("terminal:status", {
      sessionId,
      shell,
      status: "stopped",
      transport,
    });
  }

  function hasActiveSessions() {
    return terminalSessions.size > 0;
  }

  async function stopAllProcesses() {
    await Promise.all(
      [...terminalSessions.keys()].map((sessionId) =>
        stopTerminalSession(sessionId),
      ),
    );
  }

  async function startTerminal({
    command,
    cwd,
    sessionId,
    shellPath,
    strictCwd,
  }) {
    if (!sessionId || !cwd) {
      throw new Error("Missing terminal parameters.");
    }

    await stopTerminalSession(sessionId);

    const shellCandidates = buildTerminalShellCandidates(shellPath);
    const resolvedCwd = resolveTerminalCwd(cwd, { strict: strictCwd === true });

    let terminalSession;
    let chosenShell = null;
    const spawnErrors = [];

    for (const candidate of shellCandidates) {
      try {
        terminalSession = spawnPty(candidate.command, candidate.args, {
          cols: 120,
          cwd: resolvedCwd,
          env: {
            ...process.env,
            PROMPT_EOL_MARK: "",
            TERM: "xterm-256color",
          },
          name: "xterm-256color",
          rows: 36,
        });
        chosenShell = candidate;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spawnErrors.push(
          `${candidate.command} (${candidate.label}): ${message}`,
        );
      }
    }

    if (!terminalSession || !chosenShell) {
      const pipeFallbackCandidate = getPipeFallbackShell();

      let child;
      try {
        child = spawnProcess(
          pipeFallbackCandidate.command,
          pipeFallbackCandidate.args,
          {
            cwd: resolvedCwd,
            detached: process.platform !== "win32",
            env: {
              ...process.env,
              BASH_SILENCE_DEPRECATION_WARNING: "1",
              PROMPT_EOL_MARK: "",
              PS1: "\\u@\\h \\W $ ",
              TERM: "xterm-256color",
            },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spawnErrors.push(
          `${pipeFallbackCandidate.command} (${pipeFallbackCandidate.label}): ${message}`,
        );
        const detail =
          spawnErrors.length > 0 ? `\r\n${spawnErrors.join("\r\n")}` : "";
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] Unable to start shell.${detail}\r\n`,
          sessionId,
        });
        sendToRenderer("terminal:status", {
          sessionId,
          status: "stopped",
        });
        return { status: "stopped" };
      }

      if (typeof child.pid !== "number") {
        const detail =
          spawnErrors.length > 0 ? `\r\n${spawnErrors.join("\r\n")}` : "";
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] Shell started without a PID.${detail}\r\n`,
          sessionId,
        });
        sendToRenderer("terminal:status", {
          sessionId,
          status: "stopped",
        });
        return { status: "stopped" };
      }

      const output = createTerminalOutput({
        sessionId,
        send: sendToRenderer,
        pause: () => {
          child.stdout?.pause();
          child.stderr?.pause();
        },
        resume: () => {
          child.stdout?.resume();
          child.stderr?.resume();
        },
      });
      terminalOutputs.set(sessionId, output);
      terminalSessions.set(sessionId, {
        kill: () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore stop failures after the process tree exits
          }
        },
        pid: child.pid,
        write: (data) => {
          if (
            typeof data !== "string" ||
            !child.stdin ||
            child.stdin.destroyed ||
            child.stdin.writableEnded
          ) {
            return;
          }

          child.stdin.write(data);
        },
      });
      terminalTransports.set(sessionId, "pipe");
      const shellCommand = formatShellCommand(
        pipeFallbackCandidate.command,
        pipeFallbackCandidate.args,
      );
      terminalShells.set(sessionId, shellCommand);

      sendToRenderer("terminal:status", {
        pid: child.pid,
        sessionId,
        shell: shellCommand,
        status: "running",
        transport: "pipe",
      });

      if (spawnErrors.length > 0) {
        sendToRenderer("terminal:data", {
          chunk: `\u001b[2m[terminal info] PTY unavailable; using pipe fallback.\u001b[0m\r\n`,
          sessionId,
        });
      }

      child.stdout?.on("data", (chunk) => {
        output.write(chunk.toString());
      });

      child.stderr?.on("data", (chunk) => {
        output.write(chunk.toString());
      });

      child.on("close", (code, signal) => {
        if (terminalOutputs.get(sessionId) !== output) return;
        clearTerminalStartupTimer(sessionId);
        output.flush();
        output.dispose();
        terminalOutputs.delete(sessionId);
        terminalSessions.delete(sessionId);
        terminalTransports.delete(sessionId);
        terminalShells.delete(sessionId);
        sendToRenderer("terminal:status", {
          code,
          sessionId,
          shell: shellCommand,
          signal,
          status: "stopped",
          transport: "pipe",
        });
      });

      child.on("error", (error) => {
        if (terminalOutputs.get(sessionId) !== output) return;
        clearTerminalStartupTimer(sessionId);
        output.flush();
        output.dispose();
        terminalOutputs.delete(sessionId);
        terminalSessions.delete(sessionId);
        terminalTransports.delete(sessionId);
        terminalShells.delete(sessionId);
        sendToRenderer("terminal:data", {
          chunk: `\r\n[terminal error] ${error.message}\r\n`,
          sessionId,
        });
        sendToRenderer("terminal:status", {
          sessionId,
          shell: shellCommand,
          status: "stopped",
          transport: "pipe",
        });
      });

      writeTerminalStartupCommands(
        sessionId,
        createTerminalStartupCommands(command),
      );

      return {
        pid: child.pid,
        shell: shellCommand,
        status: "running",
        transport: "pipe",
      };
    }

    terminalSessions.set(sessionId, terminalSession);
    terminalTransports.set(sessionId, "pty");
    const shellCommand = formatShellCommand(
      chosenShell.command,
      chosenShell.args,
    );
    terminalShells.set(sessionId, shellCommand);
    sendToRenderer("terminal:status", {
      pid: terminalSession.pid,
      sessionId,
      shell: shellCommand,
      status: "running",
      transport: "pty",
    });

    const output = createTerminalOutput({
      sessionId,
      send: sendToRenderer,
      pause: () => terminalSession.pause(),
      resume: () => terminalSession.resume(),
    });
    terminalOutputs.set(sessionId, output);
    terminalSession.onData((chunk) => output.write(chunk));

    terminalSession.onExit(({ exitCode, signal }) => {
      if (terminalOutputs.get(sessionId) !== output) return;
      clearTerminalStartupTimer(sessionId);
      output.flush();
      output.dispose();
      terminalOutputs.delete(sessionId);
      terminalSessions.delete(sessionId);
      terminalTransports.delete(sessionId);
      terminalShells.delete(sessionId);
      sendToRenderer("terminal:status", {
        code: exitCode,
        sessionId,
        shell: shellCommand,
        signal: signal ?? null,
        status: "stopped",
        transport: "pty",
      });
    });

    writeTerminalStartupCommands(
      sessionId,
      createTerminalStartupCommands(command),
    );

    return {
      pid: terminalSession.pid,
      shell: shellCommand,
      status: "running",
      transport: "pty",
    };
  }

  function writeTerminalInput({ data, sessionId }) {
    if (!sessionId || typeof data !== "string") {
      return;
    }

    const session = terminalSessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      session.write(data);
    } catch {
      // ignore write failures after process/session exits
    }
  }

  function resizeTerminal({ cols, sessionId, rows }) {
    if (!sessionId) {
      return;
    }

    const session = terminalSessions.get(sessionId);
    if (!session || typeof session.resize !== "function") {
      return;
    }

    const normalizedCols = Math.floor(Number(cols));
    const normalizedRows = Math.floor(Number(rows));

    if (
      !Number.isFinite(normalizedCols) ||
      !Number.isFinite(normalizedRows) ||
      normalizedCols < 2 ||
      normalizedRows < 1
    ) {
      return;
    }

    try {
      session.resize(normalizedCols, normalizedRows);
    } catch {
      // ignore resize failures after session exits
    }
  }

  return {
    acknowledgeTerminalOutput: (event) => {
      if (event && typeof event.sessionId === "string") {
        terminalOutputs.get(event.sessionId)?.acknowledge(event);
      }
    },
    getTerminalOutputDiagnostics: () =>
      [...terminalOutputs.values()].map((output) => output.getDiagnostics()),
    hasActiveSessions,
    resizeTerminal,
    startTerminal,
    stopAllProcesses,
    stopTerminalSession,
    writeTerminalInput,
  };
}
