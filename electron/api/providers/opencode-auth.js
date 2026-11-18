/**
 * OpenCode's stored logins, as the usage limits read uses them: the
 * OpenCode Go API key in `$XDG_DATA_HOME/opencode/auth.json` (by default
 * `~/.local/share/opencode/auth.json`).
 *
 * The file system and the environment are passed in as ports: the real
 * ones in production, fakes in tests.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @param {object} [ports]
 * @param {Record<string, string | undefined>} [ports.env] `XDG_DATA_HOME` moves OpenCode's data directory
 * @param {() => string} [ports.homedir]
 * @param {(filePath: string) => Promise<string>} [ports.readFile]
 */
export const createOpenCodeAuth = ({
  env = process.env,
  homedir = os.homedir,
  readFile = (filePath) => fs.readFile(filePath, "utf8"),
} = {}) => {
  const authPath = () => {
    const xdgDataHome = env.XDG_DATA_HOME?.trim();
    return path.join(
      xdgDataHome || path.join(homedir(), ".local", "share"),
      "opencode",
      "auth.json",
    );
  };

  /**
   * The OpenCode Go API key, trimmed, or null when the file is missing, is
   * not JSON or has no `opencode-go` key.
   * @returns {Promise<string | null>}
   */
  const readGoApiKey = async () => {
    let raw;
    try {
      raw = await readFile(authPath());
    } catch {
      return null;
    }

    try {
      const auth = JSON.parse(raw);
      const entry = auth?.["opencode-go"];
      const key = typeof entry?.key === "string" ? entry.key.trim() : "";
      return key || null;
    } catch {
      return null;
    }
  };

  return { readGoApiKey };
};

/** OpenCode's logins on this machine. */
export const openCodeAuth = createOpenCodeAuth();
