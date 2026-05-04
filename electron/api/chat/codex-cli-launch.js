import path from "node:path";
import { execFileAsync } from "../shared/cli.js";

export const getCodexCliSpawnErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Codex CLI not found. Install it or add it to PATH, then restart Dream.";
  }

  return error instanceof Error ? error.message : "Codex CLI request failed.";
};

export const resolveCodexCliLaunch = async () => {
  if (process.platform !== "win32") {
    return { argsPrefix: [], command: "codex" };
  }

  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-Command codex -ErrorAction Stop).Path"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    const resolvedPath = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!resolvedPath) {
      return { argsPrefix: [], command: "codex" };
    }

    const lowerResolvedPath = resolvedPath.toLowerCase();
    if (
      lowerResolvedPath.endsWith(".ps1") ||
      lowerResolvedPath.endsWith(".cmd")
    ) {
      const basedir = path.dirname(resolvedPath);
      const nodeExecutable = path.join(basedir, "node.exe");
      const codexEntrypoint = path.join(
        basedir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );

      return {
        argsPrefix: [codexEntrypoint],
        command: nodeExecutable,
      };
    }

    return { argsPrefix: [], command: resolvedPath };
  } catch {
    return { argsPrefix: [], command: "codex" };
  }
};
