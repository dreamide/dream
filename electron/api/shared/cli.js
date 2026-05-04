import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

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

export const getCliVersion = async (commandName) => {
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
