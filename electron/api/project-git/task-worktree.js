import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getGitRepositoryInfo,
  gitRefExists,
  listProjectGitWorktrees,
  runGitCommand,
} from "./core.js";

/** HTTP-friendly marker: the worktree is gone, which no agent can fix. */
export const TASK_WORKTREE_MISSING = "TASK_WORKTREE_MISSING";

export const createTaskWorktreeMissingError = (worktreePath) => {
  const error = new Error(
    `This task's worktree is no longer a git checkout: ${worktreePath}`,
  );
  error.code = TASK_WORKTREE_MISSING;
  return error;
};

export const isGitCheckout = async (directory) => {
  try {
    if (!(await fs.stat(directory)).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  // The folder must be the checkout's own root: a plain folder inside some
  // other repository also counts as "inside a work tree".
  const result = await runGitCommand(
    directory,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  if (!result.ok || !result.stdout.trim()) {
    return false;
  }

  const [topLevel, target] = await Promise.all(
    [result.stdout.trim(), directory].map(async (entry) => {
      const resolved = path.resolve(entry);
      try {
        return (await fs.realpath(resolved)).toLowerCase();
      } catch {
        return resolved.toLowerCase();
      }
    }),
  );
  return topLevel === target;
};

const readCurrentBranch = async (directory) => {
  const result = await runGitCommand(
    directory,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { allowFailure: true },
  );
  return result.ok ? result.stdout.trim() : "";
};

/**
 * Whether a task's worktree can still be used, and whether it could be brought
 * back: the branch outlives the folder when a worktree is removed by hand.
 */
export const getTaskWorktreeStatus = async (
  projectPath,
  { branch, worktreePath },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  const isCheckout = await isGitCheckout(worktreePath);
  return {
    branchExists:
      Boolean(repoInfo.isRepo && repoInfo.repoRoot && branch) &&
      (await gitRefExists(repoInfo.repoRoot, `refs/heads/${branch}`)),
    isCheckout,
  };
};

/**
 * Checks the task's existing branch out again at the task's worktree path.
 * Nothing is overwritten: a folder that still holds files but is not a
 * checkout stops this, because only the user knows what those files are.
 */
export const recreateTaskWorktree = async (
  projectPath,
  { branch, worktreePath },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }
  if (!(await gitRefExists(repoInfo.repoRoot, `refs/heads/${branch}`))) {
    throw new Error(
      `Branch "${branch}" no longer exists, so the worktree cannot be recreated.`,
    );
  }

  const targetPath = path.resolve(worktreePath);
  const worktreesInfo = await listProjectGitWorktrees(projectPath);
  const result = {
    branch,
    mainWorktreePath: worktreesInfo.mainWorktreePath ?? repoInfo.repoRoot,
    path: targetPath,
    repoRoot: repoInfo.repoRoot,
  };

  if (await isGitCheckout(targetPath)) {
    if ((await readCurrentBranch(targetPath)) === branch) {
      return result;
    }
    throw new Error(
      `${targetPath} is a checkout of a different branch, not "${branch}".`,
    );
  }

  let entries = [];
  try {
    entries = await fs.readdir(targetPath);
  } catch {
    // The folder is gone, which is the usual case.
  }
  if (entries.length > 0) {
    throw new Error(
      `${targetPath} still contains files but is not a git checkout. Move or remove it, then try again.`,
    );
  }

  // Forget the registration of the worktree that used to live there.
  await runGitCommand(repoInfo.repoRoot, ["worktree", "prune"]);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runGitCommand(repoInfo.repoRoot, [
    "worktree",
    "add",
    targetPath,
    branch,
  ]);

  return result;
};
