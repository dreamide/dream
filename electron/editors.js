import { spawn as spawnProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { shell } from "electron";

const WINDOWS_POWERSHELL_PATH =
  process.platform === "win32"
    ? path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : null;
const WINDOWS_CMD_PATH =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
    : null;

const KNOWN_EDITORS = [
  // IDEs & editors
  {
    id: "vscode",
    name: "VS Code",
    win: [
      ...(process.env.LOCALAPPDATA
        ? [
            path.join(
              process.env.LOCALAPPDATA,
              "Programs",
              "Microsoft VS Code",
              "Code.exe",
            ),
            path.join(
              process.env.LOCALAPPDATA,
              "Programs",
              "Microsoft VS Code",
              "bin",
              "code.cmd",
            ),
          ]
        : []),
      ...(process.env.ProgramFiles
        ? [path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")]
        : []),
      ...(process.env["ProgramFiles(x86)"]
        ? [
            path.join(
              process.env["ProgramFiles(x86)"],
              "Microsoft VS Code",
              "Code.exe",
            ),
          ]
        : []),
      "code.exe",
      "code.cmd",
    ],
    mac: [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ],
    linux: ["code"],
    args: (p) => [p],
  },
  {
    id: "cursor",
    name: "Cursor",
    win: ["cursor.cmd", "cursor.exe"],
    mac: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
    linux: ["cursor"],
    args: (p) => [p],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    win: ["windsurf.cmd", "windsurf.exe"],
    mac: ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],
    linux: ["windsurf"],
    args: (p) => [p],
  },
  {
    id: "zed",
    name: "Zed",
    win: ["zed.exe"],
    mac: ["/Applications/Zed.app/Contents/MacOS/cli"],
    linux: ["zed"],
    args: (p) => [p],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    win: ["webstorm64.exe", "webstorm.cmd"],
    mac: ["/Applications/WebStorm.app/Contents/MacOS/webstorm"],
    linux: ["webstorm"],
    args: (p) => [p],
  },
  {
    id: "phpstorm",
    name: "PhpStorm",
    win: ["phpstorm64.exe", "phpstorm.cmd"],
    mac: ["/Applications/PhpStorm.app/Contents/MacOS/phpstorm"],
    linux: ["phpstorm"],
    args: (p) => [p],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    win: ["pycharm64.exe", "pycharm.cmd"],
    mac: ["/Applications/PyCharm.app/Contents/MacOS/pycharm"],
    linux: ["pycharm"],
    args: (p) => [p],
  },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    win: ["idea64.exe", "idea.cmd"],
    mac: ["/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"],
    linux: ["idea"],
    args: (p) => [p],
  },
  {
    id: "sublime",
    name: "Sublime Text",
    win: [
      "C:\\Program Files\\Sublime Text\\subl.exe",
      "C:\\Program Files\\Sublime Text 3\\subl.exe",
    ],
    mac: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"],
    linux: ["subl"],
    args: (p) => [p],
  },
  {
    id: "vim",
    name: "Vim",
    win: [],
    mac: ["vim"],
    linux: ["vim"],
    args: (p) => [p],
  },
  {
    id: "neovim",
    name: "Neovim",
    win: ["nvim.exe"],
    mac: ["nvim"],
    linux: ["nvim"],
    args: (p) => [p],
  },
  // File explorers (shown as default "open folder" option)
  {
    id: "file-explorer",
    name:
      process.platform === "win32"
        ? "File Explorer"
        : process.platform === "darwin"
          ? "Finder"
          : "Files",
    win: ["explorer.exe"],
    mac: ["open"],
    linux: ["xdg-open"],
    args: (p) => [p],
    isFileExplorer: true,
  },
  // Terminal
  {
    id: "terminal",
    name: "Terminal",
    win: [
      ...(process.env.ProgramFiles
        ? [path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")]
        : []),
      "pwsh.exe",
      ...(WINDOWS_POWERSHELL_PATH ? [WINDOWS_POWERSHELL_PATH] : []),
      "powershell.exe",
      "wt.exe",
      ...(WINDOWS_CMD_PATH ? [WINDOWS_CMD_PATH] : []),
      "cmd.exe",
    ],
    mac: ["open", "/Applications/iTerm.app"],
    linux: ["x-terminal-emulator", "gnome-terminal", "konsole"],
    args: (p, executable) => {
      if (process.platform === "darwin") {
        return ["-a", "Terminal", p];
      }

      if (process.platform === "win32") {
        const executableName = executable
          ? path.basename(executable).toLowerCase()
          : "";

        if (executableName === "wt.exe") {
          return ["-d", p];
        }

        if (executableName === "cmd.exe") {
          return ["/K"];
        }

        return ["-NoExit"];
      }

      return [p];
    },
    isTerminal: true,
  },
];

function getPlatformEditorKey() {
  return process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
}

function resolveExecutable(name) {
  if (path.isAbsolute(name)) {
    return existsSync(name) ? name : null;
  }

  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(sep);

  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      if (existsSync(full) && statSync(full).isFile()) {
        return full;
      }
    } catch {
      // skip
    }
  }

  return null;
}

let cachedEditors = null;
let cachedEditorsTimestamp = 0;
const EDITOR_CACHE_TTL_MS = 30_000;

export function detectAvailableEditors() {
  const now = Date.now();
  if (cachedEditors && now - cachedEditorsTimestamp < EDITOR_CACHE_TTL_MS) {
    return cachedEditors;
  }

  const platformKey = getPlatformEditorKey();
  const results = [];

  for (const editor of KNOWN_EDITORS) {
    const candidates = editor[platformKey] || [];
    if (editor.isFileExplorer) {
      const resolved = candidates.map(resolveExecutable).find(Boolean) ?? null;
      results.push({
        id: editor.id,
        name: editor.name,
        executable: resolved,
        isFileExplorer: true,
        isTerminal: false,
      });
      continue;
    }

    for (const candidate of candidates) {
      const resolved = resolveExecutable(candidate);
      if (resolved) {
        results.push({
          id: editor.id,
          name: editor.name,
          executable: resolved,
          isFileExplorer: editor.isFileExplorer || false,
          isTerminal: editor.isTerminal || false,
        });
        break;
      }
    }
  }

  cachedEditors = results;
  cachedEditorsTimestamp = now;
  return results;
}

function resolveKnownEditor(editorId) {
  const editorDef = KNOWN_EDITORS.find((editor) => editor.id === editorId);
  if (!editorDef) {
    return null;
  }

  const platformKey = getPlatformEditorKey();
  const candidates = editorDef[platformKey] || [];

  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (!resolved) {
      continue;
    }

    return {
      executable: resolved,
      id: editorDef.id,
      isFileExplorer: editorDef.isFileExplorer || false,
      isTerminal: editorDef.isTerminal || false,
      name: editorDef.name,
    };
  }

  return null;
}

export function openProjectInEditor({ editorId, projectPath }) {
  if (!projectPath || typeof projectPath !== "string") {
    return false;
  }

  const editor = resolveKnownEditor(editorId);
  if (!editor) {
    if (editorId === "terminal") {
      return false;
    }

    shell.openPath(projectPath);
    return true;
  }

  const editorDef = KNOWN_EDITORS.find((e) => e.id === editorId);
  const args = editorDef
    ? editorDef.args(projectPath, editor.executable)
    : [projectPath];

  if (process.platform === "win32" && editor.isTerminal) {
    const launcher = WINDOWS_CMD_PATH ?? "cmd.exe";
    spawnProcess(
      launcher,
      [
        "/d",
        "/s",
        "/c",
        "start",
        "",
        "/D",
        projectPath,
        editor.executable,
        ...args,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    ).unref();

    return true;
  }

  const requiresShell =
    process.platform === "win32" &&
    [".bat", ".cmd"].includes(path.extname(editor.executable).toLowerCase());

  spawnProcess(editor.executable, args, {
    detached: true,
    shell: requiresShell,
    stdio: "ignore",
  }).unref();

  return true;
}
