import { promises as fs } from "node:fs";
import path from "node:path";
import {
  execCliCommand,
  getCliVersion,
  isCliCommandAvailable,
} from "../shared/cli.js";

const CURSOR_CLI_COMMANDS = ["agent", "cursor-agent"];
const CURSOR_CLI_CACHE_TTL_MS = 30_000;

let cachedCursorCli = null;
let cachedCursorCliTimestamp = 0;

const isLikelyCursorAgentHelp = (value) =>
  /cursor/i.test(value) && /agent/i.test(value);

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
    const result = await execCliCommand(commandName, ["--help"], {
      timeout: 3000,
    });
    return isLikelyCursorAgentHelp(`${result.stdout}\n${result.stderr}`);
  } catch {
    return false;
  }
};

export const getCursorCliCommand = async ({ force = false } = {}) => {
  const now = Date.now();
  if (
    !force &&
    cachedCursorCli &&
    now - cachedCursorCliTimestamp < CURSOR_CLI_CACHE_TTL_MS
  ) {
    return cachedCursorCli;
  }

  for (const commandName of getCursorCliCandidates()) {
    if (await isCursorCommandCandidate(commandName)) {
      cachedCursorCli = commandName;
      cachedCursorCliTimestamp = now;
      return commandName;
    }
  }

  cachedCursorCli = null;
  cachedCursorCliTimestamp = now;
  return null;
};

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
