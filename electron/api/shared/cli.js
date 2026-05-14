import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

const CLI_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
const cliVersionCache = new Map();

export const isCliCommandAvailable = async (commandName) => {
  try {
    if (process.platform === "win32") {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Command ${commandName} -ErrorAction Stop).Path`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );
      return true;
    }

    await execFileAsync("which", [commandName], {
      encoding: "utf8",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
};

const readCliVersion = async (commandName) => {
  try {
    if (process.platform === "win32") {
      const result = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$command = (Get-Command ${commandName} -ErrorAction Stop).Path; & $command --version`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );

      return result.stdout.trim() || result.stderr.trim() || null;
    }

    const result = await execFileAsync(commandName, ["--version"], {
      encoding: "utf8",
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
