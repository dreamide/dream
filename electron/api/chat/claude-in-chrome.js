// Claude in Chrome: the Claude Code CLI's built-in MCP server that drives the
// user's own Chrome through the Claude browser extension. Its tools are named
// `mcp__claude-in-chrome__*`.
//
// The CLI turns it on for interactive sessions when the user has chosen
// "Enabled by default" under `/chrome`, but a headless (SDK) session ignores
// that choice and loads it only when launched with `--chrome`. Reading the
// same choice here gives Dream's Claude chats the same browser as the CLI.

import { promises as fs } from "node:fs";
import path from "node:path";
import { getHomeDirectory } from "../skills/scan.js";

/** The launch arguments that turn Claude in Chrome on for one session. */
export const CLAUDE_IN_CHROME_EXTRA_ARGS = Object.freeze({ chrome: null });

// Claude Code keeps its global state, including the `/chrome` choice, in
// `.claude.json` inside CLAUDE_CONFIG_DIR when set, else the home directory.
const getClaudeGlobalConfigPath = () =>
  path.join(
    process.env.CLAUDE_CONFIG_DIR?.trim() || getHomeDirectory(),
    ".claude.json",
  );

/**
 * Whether the user has turned Claude in Chrome on by default in Claude Code.
 * A missing or unreadable config means no: the CLI's own default is off.
 */
export const isClaudeInChromeEnabledByDefault = async () => {
  try {
    const config = JSON.parse(
      await fs.readFile(getClaudeGlobalConfigPath(), "utf8"),
    );
    return config?.claudeInChromeDefaultEnabled === true;
  } catch {
    return false;
  }
};
