import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cliCatalog,
  execCliCommand,
  getCliVersion,
  isCliCommandAvailable,
} from "../shared/cli.js";

const CURSOR_CLI_COMMANDS = ["agent", "cursor-agent"];

/**
 * Other tools also install a generic `agent` binary (Grok Build does, and its
 * help even mentions a `cursor-worker` command), so matching words in the
 * help text is not enough. Cursor Agent prints a date-based build as its
 * version, e.g. `2026.05.28-a70ca7c`; Grok prints `grok 1.0.41 (...)`.
 */
export const isCursorAgentVersionOutput = (value) =>
  /^\s*\d{4}\.\d{2}\.\d{2}-[0-9a-f]+\s*$/i.test(String(value ?? ""));

const getCursorCliPathCandidates = () => {
  if (process.platform !== "win32") {
    return [];
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return [];
  }

  const installDir = path.join(localAppData, "cursor-agent");
  return [
    path.join(installDir, "agent.cmd"),
    path.join(installDir, "cursor-agent.cmd"),
  ];
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const getCursorCliCandidates = () => [
  ...CURSOR_CLI_COMMANDS,
  ...getCursorCliPathCandidates(),
];

const isCursorCommandCandidate = async (commandName) => {
  if (
    path.isAbsolute(commandName)
      ? !(await fileExists(commandName))
      : !(await isCliCommandAvailable(commandName))
  ) {
    return false;
  }

  if (!/(^|[\\/])agent(?:\.(?:cmd|ps1))?$/i.test(commandName)) {
    return true;
  }

  try {
    const result = await execCliCommand(commandName, ["--version"], {
      closeStdin: true,
      timeout: 5000,
    });
    return isCursorAgentVersionOutput(result.stdout || result.stderr);
  } catch {
    return false;
  }
};

/**
 * Which command is Cursor Agent, or null: remembered in the CLI catalog
 * under its policy (cli-catalog.js).
 */
export const getCursorCliCommand = ({ force = false } = {}) =>
  cliCatalog.derived(
    "cursor-command",
    async () => {
      for (const commandName of getCursorCliCandidates()) {
        if (await isCursorCommandCandidate(commandName)) {
          return commandName;
        }
      }
      return null;
    },
    { force },
  );

export const isCursorCliAvailable = async (options = {}) =>
  (await getCursorCliCommand(options)) !== null;

export const getCursorCliVersion = async ({ force = false } = {}) => {
  const commandName = await getCursorCliCommand({ force });
  return commandName ? getCliVersion(commandName, { force }) : null;
};

export const execCursorCliCommand = async (args = [], options = {}) => {
  const commandName = await getCursorCliCommand();
  if (!commandName) {
    throw new Error(getCursorCliUnavailableMessage());
  }

  return execCliCommand(commandName, args, options);
};

export const getCursorCliUnavailableMessage = () =>
  "Cursor Agent CLI is not installed or not available. Install Cursor Agent CLI or add `agent` to PATH.";

export const getCursorCliSpawnErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return getCursorCliUnavailableMessage();
  }

  return error instanceof Error ? error.message : "Cursor CLI request failed.";
};

export const normalizeCursorCliModel = (model) => {
  const trimmed = String(model ?? "").trim();
  const normalized = trimmed.toLowerCase();
  return !normalized || normalized === "auto" || normalized === "cursor-auto"
    ? "auto"
    : trimmed;
};

export const resolveCursorCliLaunch = async () => {
  const commandName = await getCursorCliCommand();
  if (!commandName) {
    throw new Error(getCursorCliUnavailableMessage());
  }

  return {
    argsPrefix: [],
    command: commandName,
    shell: process.platform === "win32",
  };
};
