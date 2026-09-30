// What Dream itself holds for a project directory, apart from git: agent
// processes that may keep handles inside it, and the checkpoint snapshots
// kept for it. The worktree lifecycle calls these when a directory is
// removed, so it never has to know which subsystems those are.
import { stopIdleCodexAppServer } from "./chat/codex-app-server-client.js";
import { deleteProjectCheckpoints } from "./checkpoints/service.js";

/**
 * Releases handles agent processes still hold inside a project directory,
 * so the directory can be deleted. On Windows a folder cannot go while any
 * process has a handle in it, and agent CLIs that ran there are the usual
 * holders. Best effort: an agent mid-turn is left alone.
 */
export const releaseProjectDirectory = async () => {
  try {
    await stopIdleCodexAppServer();
  } catch {
    // Releasing the agent process is best effort.
  }
};

/**
 * Drops everything Dream kept for a project directory that is going away
 * for good (its checkpoint snapshots). Best effort: leftover snapshots are
 * harmless, and the removal itself must not fail on them.
 */
export const forgetProjectDirectory = async (projectPath) => {
  try {
    await deleteProjectCheckpoints(projectPath);
  } catch {
    // Leftover snapshots are harmless.
  }
};
