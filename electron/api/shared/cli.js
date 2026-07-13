import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

const CLI_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
const cliVersionCache = new Map();

const SHELL_PATH_MARKER_START = "__DREAM_CLI_PATH_START__";
const SHELL_PATH_MARKER_END = "__DREAM_CLI_PATH_END__";

let cliEnvironmentPromise = null;

const quotePowerShellString = (value) =>
  `'${String(value).replace(/'/g, "''")}'`;

const getPathKey = (env = process.env) => {
  if (process.platform !== "win32") {
    return "PATH";
  }

  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
};

const getPathValue = (env = process.env) => env[getPathKey(env)] ?? "";

const splitPathEntries = (value) =>
  String(value ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

const expandHomePath = (entry) => {
  if (!entry.startsWith("~")) {
    return entry;
  }

  const homeDir = os.homedir();
  if (!homeDir) {
    return entry;
  }

  return path.join(homeDir, entry.slice(1));
};

const dedupePathEntries = (entries) => {
  const seen = new Set();
  const deduped = [];
  for (const rawEntry of entries) {
    const entry = expandHomePath(rawEntry);
    const key = process.platform === "win32" ? entry.toLowerCase() : entry;
    if (!entry || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
};

const extractMarkedShellPath = (value) => {
  const output = String(value ?? "");
  const startIndex = output.indexOf(SHELL_PATH_MARKER_START);
  if (startIndex < 0) {
    return "";
  }

  const pathStart = startIndex + SHELL_PATH_MARKER_START.length;
  const endIndex = output.indexOf(SHELL_PATH_MARKER_END, pathStart);
  if (endIndex < 0) {
    return "";
  }

  return output.slice(pathStart, endIndex).trim();
};

const getCommonCliPathEntries = () => {
  if (process.platform === "win32") {
    const entries = [];
    if (process.env.LOCALAPPDATA) {
      entries.push(path.join(process.env.LOCALAPPDATA, "cursor-agent"));
    }
    if (process.env.APPDATA) {
      entries.push(path.join(process.env.APPDATA, "npm"));
    }
    entries.push("~/.grok/bin");
    return entries;
  }

  const entries = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  if (process.platform === "darwin") {
    entries.push("~/Library/pnpm");
  }

  entries.push(
    "~/.local/bin",
    "~/.local/share/pnpm",
    "~/.opencode/bin",
    "~/.grok/bin",
    "~/.npm-global/bin",
    "~/.cargo/bin",
    "~/.bun/bin",
    "~/.deno/bin",
  );

  return entries;
};

const getShellPathCommand = (shellPath) => {
  const shellName = path.basename(shellPath).toLowerCase();
  if (shellName.includes("fish")) {
    return `printf '%s%s%s' ${SHELL_PATH_MARKER_START} (string join : $PATH) ${SHELL_PATH_MARKER_END}`;
  }

  return `printf '${SHELL_PATH_MARKER_START}%s${SHELL_PATH_MARKER_END}' "$PATH"`;
};

const readLoginShellPath = async () => {
  if (process.platform === "win32") {
    return "";
  }

  const shellPath =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");

  try {
    const result = await execFileAsync(
      shellPath,
      ["-ilc", getShellPathCommand(shellPath)],
      {
        encoding: "utf8",
        env: process.env,
        timeout: 5000,
        windowsHide: true,
      },
    );
    return extractMarkedShellPath(`${result.stdout}\n${result.stderr}`);
  } catch {
    return "";
  }
};

const ensureCliEnvironment = async () => {
  if (!cliEnvironmentPromise) {
    cliEnvironmentPromise = (async () => {
      const pathKey = getPathKey();
      const currentPath = getPathValue();
      const shellPath = await readLoginShellPath();
      const pathEntries = dedupePathEntries([
        ...splitPathEntries(currentPath),
        ...splitPathEntries(shellPath),
        ...getCommonCliPathEntries(),
      ]);
      const augmentedPath = pathEntries.join(path.delimiter);

      // Packaged GUI apps, especially on macOS, often start without the user's
      // shell PATH. Mutate process.env so downstream libraries that spawn CLIs
      // directly (for example Claude Code's SDK adapter) inherit the same fix.
      process.env[pathKey] = augmentedPath;
      if (pathKey !== "PATH") {
        process.env.PATH = augmentedPath;
      }

      return {
        ...process.env,
        [pathKey]: augmentedPath,
        PATH: augmentedPath,
      };
    })();
  }

  return cliEnvironmentPromise;
};

const isExecutableFile = async (filePath) => {
  try {
    await access(
      filePath,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
};

const resolveCommandFromPath = async (commandName, env) => {
  if (path.isAbsolute(commandName) || commandName.includes(path.sep)) {
    return (await isExecutableFile(commandName)) ? commandName : null;
  }

  for (const dir of splitPathEntries(getPathValue(env))) {
    const candidate = path.join(dir, commandName);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
};

export const isCliCommandAvailable = async (commandName) => {
  const commandPath = await resolveCliCommandPath(commandName);
  return commandPath !== null;
};

export const resolveCliCommandPath = async (commandName) => {
  const env = await ensureCliEnvironment();

  try {
    if (process.platform === "win32") {
      const result = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Command ${quotePowerShellString(commandName)} -ErrorAction Stop).Path`,
        ],
        {
          encoding: "utf8",
          env,
          windowsHide: true,
        },
      );

      return result.stdout.trim() || null;
    }

    return await resolveCommandFromPath(commandName, env);
  } catch {
    return null;
  }
};

const readCliVersion = async (commandName) => {
  const env = await ensureCliEnvironment();

  try {
    if (process.platform === "win32") {
      const result = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$command = (Get-Command ${quotePowerShellString(commandName)} -ErrorAction Stop).Path; & $command --version`,
        ],
        {
          encoding: "utf8",
          env,
          windowsHide: true,
        },
      );

      return result.stdout.trim() || result.stderr.trim() || null;
    }

    const commandPath = await resolveCliCommandPath(commandName);
    if (!commandPath) {
      return null;
    }

    const result = await execFileAsync(commandPath, ["--version"], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });

    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
};

export const getCliVersion = async (commandName, { force = false } = {}) => {
  const now = Date.now();
  const cached = cliVersionCache.get(commandName);
  if (!force && cached) {
    if (cached.promise) {
      return cached.promise;
    }

    if (now - cached.fetchedAt < CLI_VERSION_CACHE_TTL_MS) {
      return cached.value;
    }
  }

  const promise = readCliVersion(commandName).then((value) => {
    cliVersionCache.set(commandName, {
      fetchedAt: Date.now(),
      value,
    });
    return value;
  });

  cliVersionCache.set(commandName, {
    fetchedAt: now,
    promise,
    value: cached?.value ?? null,
  });

  return promise;
};

export const execCliCommand = async (commandName, args = [], options = {}) => {
  const env = await ensureCliEnvironment();
  const execOptions = {
    encoding: "utf8",
    windowsHide: true,
    ...options,
    env: {
      ...env,
      ...(options.env ?? {}),
    },
  };

  if (process.platform === "win32") {
    const psArgs = [
      "-NoProfile",
      "-Command",
      [
        `$command = (Get-Command ${quotePowerShellString(commandName)} -ErrorAction Stop).Path`,
        ["& $command", ...args.map((arg) => JSON.stringify(String(arg)))].join(
          " ",
        ),
      ].join("; "),
    ];

    return execFileAsync("powershell.exe", psArgs, execOptions);
  }

  const commandPath = await resolveCliCommandPath(commandName);
  return execFileAsync(commandPath ?? commandName, args, execOptions);
};
