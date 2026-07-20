import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

function isFile(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveExecutable(executable) {
  if (!executable || typeof executable !== "string") {
    return null;
  }

  if (path.isAbsolute(executable)) {
    return isFile(executable) ? executable : null;
  }

  const separator = process.platform === "win32" ? ";" : ":";
  for (const entry of (process.env.PATH || "").split(separator)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) {
      continue;
    }

    const candidate = path.join(directory, executable);
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function formatShellPath(executable, args = []) {
  const command = /\s/.test(executable)
    ? `"${executable.replaceAll('"', '\\"')}"`
    : executable;
  return [command, ...args].join(" ");
}

function getWindowsGitBashPath() {
  const candidates = [
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe")
      : null,
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          "Programs",
          "Git",
          "bin",
          "bash.exe",
        )
      : null,
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
      : null,
  ];
  const gitExecutable = resolveExecutable("git.exe");
  if (gitExecutable) {
    candidates.push(
      path.join(path.dirname(path.dirname(gitExecutable)), "bin", "bash.exe"),
    );
  }

  return candidates.find((candidate) => candidate && isFile(candidate)) ?? null;
}

function getWindowsShells() {
  const shells = [];
  const windowsPowerShellExecutable =
    resolveExecutable("powershell.exe") ??
    resolveExecutable(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );

  if (windowsPowerShellExecutable) {
    shells.push({
      id: "windows-powershell",
      label: "Windows PowerShell",
      shellPath: resolveExecutable("powershell.exe")
        ? "powershell.exe"
        : formatShellPath(windowsPowerShellExecutable),
    });
  }

  const powerShellExecutable =
    resolveExecutable("pwsh.exe") ??
    (process.env.ProgramFiles
      ? resolveExecutable(
          path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
        )
      : null);

  if (powerShellExecutable) {
    shells.push({
      id: "powershell",
      label: "PowerShell 7",
      shellPath: resolveExecutable("pwsh.exe")
        ? "pwsh.exe"
        : formatShellPath(powerShellExecutable),
    });
  }

  const commandPromptExecutable =
    resolveExecutable("cmd.exe") ??
    resolveExecutable(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
    );
  if (commandPromptExecutable) {
    shells.push({
      id: "command-prompt",
      label: "Command Prompt",
      shellPath: resolveExecutable("cmd.exe")
        ? "cmd.exe"
        : formatShellPath(commandPromptExecutable),
    });
  }

  const gitBashPath = getWindowsGitBashPath();
  if (gitBashPath) {
    shells.push({
      id: "git-bash",
      label: "Git Bash",
      shellPath: formatShellPath(gitBashPath, ["--login", "-i"]),
    });
  }

  return shells;
}

function getUnixShellLabel(executable) {
  const name = path.basename(executable).toLowerCase();
  if (name === "zsh") {
    return "Zsh";
  }
  if (name === "bash") {
    return "Bash";
  }
  if (name === "fish") {
    return "Fish";
  }
  if (name === "sh") {
    return "sh";
  }
  return path.basename(executable);
}

function getUnixShells() {
  const candidates =
    process.platform === "darwin"
      ? [
          process.env.SHELL,
          "/bin/zsh",
          "/opt/homebrew/bin/fish",
          "/usr/local/bin/fish",
          "/bin/bash",
          "/bin/sh",
        ]
      : [
          process.env.SHELL,
          "/bin/bash",
          "/usr/bin/bash",
          "/bin/zsh",
          "/usr/bin/zsh",
          "/usr/bin/fish",
          "/bin/fish",
          "/bin/sh",
        ];
  const seen = new Set();
  const shells = [];

  for (const candidate of candidates) {
    const executable = resolveExecutable(candidate);
    if (!executable) {
      continue;
    }

    const key = path.basename(executable).toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    shells.push({
      id: `shell-${shells.length}`,
      label: getUnixShellLabel(executable),
      shellPath: executable,
    });
  }

  return shells;
}

function hasWslDistribution(wslExecutable) {
  return new Promise((resolve) => {
    execFile(
      wslExecutable,
      ["--list", "--quiet"],
      {
        encoding: null,
        timeout: 3000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout)) {
          resolve(false);
          return;
        }

        resolve(Boolean(stdout.toString("utf8").replaceAll("\0", "").trim()));
      },
    );
  });
}

export function getDefaultTerminalShellPath() {
  const shells =
    process.platform === "win32" ? getWindowsShells() : getUnixShells();
  return shells[0]?.shellPath ?? "";
}

export async function detectAvailableTerminalShells() {
  const shells =
    process.platform === "win32" ? getWindowsShells() : getUnixShells();
  if (process.platform !== "win32") {
    return shells;
  }

  const wslExecutable =
    resolveExecutable("wsl.exe") ??
    resolveExecutable(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe"),
    );
  if (wslExecutable && (await hasWslDistribution(wslExecutable))) {
    shells.push({
      id: "wsl",
      label: "WSL",
      shellPath: resolveExecutable("wsl.exe")
        ? "wsl.exe"
        : formatShellPath(wslExecutable),
    });
  }

  return shells;
}
