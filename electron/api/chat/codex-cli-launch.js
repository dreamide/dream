export const getCodexCliSpawnErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Codex CLI not found. Install it or add it to PATH, then restart dream.";
  }

  return error instanceof Error ? error.message : "Codex CLI request failed.";
};

/**
 * On Windows, spawn with `shell: true` so cmd.exe resolves the bare command
 * via PATHEXT — picking up .cmd shims (npm) or .ps1/.cmd shims (pnpm) without
 * any manual path resolution or PowerShell invocation.
 *
 * This mirrors the approach used by t3code (github.com/pingdotgg/t3code).
 */
export const resolveCodexCliLaunch = async () => {
  return {
    argsPrefix: [],
    command: "codex",
    shell: process.platform === "win32",
  };
};
