import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cliCatalog,
  execCliCommand,
  getCliVersion,
  isCliCommandAvailable,
  resolveCliCommandPath,
} from "../shared/cli.js";
import { getModelReasoningEfforts } from "./model-options.js";

const ANTIGRAVITY_CLI_COMMANDS = ["agy"];

const getAntigravityCliPathCandidates = () => {
  const candidates = [];
  const homeDir = os.homedir();

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "agy", "bin", "agy.exe"),
        path.join(localAppData, "Programs", "agy", "bin", "agy.exe"),
      );
    }
    if (homeDir) {
      candidates.push(
        path.join(homeDir, ".gemini", "antigravity-cli", "bin", "agy.exe"),
        path.join(homeDir, ".gemini", "antigravity-cli", "bin", "agy.bat"),
      );
    }
  } else if (homeDir) {
    candidates.push(
      path.join(homeDir, ".gemini", "antigravity-cli", "bin", "agy"),
      path.join(homeDir, ".local", "bin", "agy"),
      "/usr/local/bin/agy",
    );
  }

  return candidates;
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const getAntigravityCliCandidates = () => [
  ...ANTIGRAVITY_CLI_COMMANDS,
  ...getAntigravityCliPathCandidates(),
];

const isAntigravityCommandCandidate = async (commandName) => {
  if (
    path.isAbsolute(commandName)
      ? !(await fileExists(commandName))
      : !(await isCliCommandAvailable(commandName))
  ) {
    return false;
  }

  return true;
};

/**
 * Which command is Antigravity CLI, or null: remembered in the CLI catalog
 * under its policy (cli-catalog.js).
 */
export const getAntigravityCliCommand = ({ force = false } = {}) =>
  cliCatalog.derived(
    "antigravity-command",
    async () => {
      for (const commandName of getAntigravityCliCandidates()) {
        if (await isAntigravityCommandCandidate(commandName)) {
          return commandName;
        }
      }
      return null;
    },
    { force },
  );

export const isAntigravityCliAvailable = async (options = {}) =>
  (await getAntigravityCliCommand(options)) !== null;

export const getAntigravityCliVersion = async ({ force = false } = {}) => {
  const commandName = await getAntigravityCliCommand({ force });
  return commandName ? getCliVersion(commandName, { force }) : null;
};

export const execAntigravityCliCommand = async (args = [], options = {}) => {
  const commandName = await getAntigravityCliCommand();
  if (!commandName) {
    throw new Error(getAntigravityCliUnavailableMessage());
  }

  return execCliCommand(commandName, args, options);
};

export const getAntigravityCliUnavailableMessage = () =>
  "Google Antigravity CLI is not installed or not available on PATH. Install Antigravity CLI and run `agy` in your terminal to authenticate.";

export const getAntigravityCliSpawnErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return getAntigravityCliUnavailableMessage();
  }

  return error instanceof Error
    ? error.message
    : "Antigravity CLI request failed.";
};

export const resolveAntigravityCliLaunch = async () => {
  const commandName = await getAntigravityCliCommand();
  if (!commandName) {
    throw new Error(getAntigravityCliUnavailableMessage());
  }

  const commandPath = await resolveCliCommandPath(commandName);
  const command = commandPath ?? commandName;
  const isBatchFile =
    process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command);

  return {
    argsPrefix: [],
    // spawn() with shell: true does not quote; cmd.exe /s strips only the outer quotes.
    command: isBatchFile && /\s/.test(command) ? `"${command}"` : command,
    shell: isBatchFile,
  };
};

const SAFE_SHELL_ARG = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const assertSafeAntigravityArg = (launch, value, label) => {
  if (launch?.shell && value && !SAFE_SHELL_ARG.test(value)) {
    throw new Error(`Unsupported ${label} for Antigravity CLI launch.`);
  }
};

export const resolveAntigravityEffort = (model, reasoningEffort) => {
  if (!reasoningEffort) return null;
  const allowed = getModelReasoningEfforts("antigravity", model ?? "");
  return allowed.includes(reasoningEffort) ? reasoningEffort : null;
};
