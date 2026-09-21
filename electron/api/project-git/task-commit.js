import { existsSync } from "node:fs";
import path from "node:path";
import { runGitCommand } from "./core.js";
import {
  createTaskWorktreeMissingError,
  isGitCheckout,
} from "./task-worktree.js";

const MAX_SUBJECT_LENGTH = 120;

const toSubjectLine = (value) =>
  typeof value === "string"
    ? (value.split(/\r?\n/).find((line) => line.trim()) ?? "")
        .trim()
        .slice(0, MAX_SUBJECT_LENGTH)
    : "";

const isMergeInProgress = async (cwd) =>
  (
    await runGitCommand(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      allowFailure: true,
    })
  ).ok;

const isRebaseInProgress = async (cwd) => {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const result = await runGitCommand(cwd, ["rev-parse", "--git-path", name], {
      allowFailure: true,
    });
    const gitPath = result.ok ? result.stdout.trim() : "";
    if (gitPath && existsSync(path.resolve(cwd, gitPath))) {
      return true;
    }
  }
  return false;
};

const readShortHead = async (cwd) => {
  const result = await runGitCommand(cwd, ["rev-parse", "--short", "HEAD"], {
    allowFailure: true,
  });
  return result.ok ? result.stdout.trim() || null : null;
};

/**
 * Records a task step's work as a commit, so committing never depends on the
 * agent choosing to (or being allowed to: users commonly tell agents to ask
 * before `git commit`, which would stall an unattended pipeline).
 *
 * - Everything in the project directory is staged and committed.
 * - Nothing to commit is not an error: the agent may have committed itself.
 * - A merge the agent left open (`git merge --no-commit`) is concluded with
 *   git's own merge message. Files still marked as conflicted stop the commit,
 *   because staging them here would record the conflict markers as resolved.
 * - A rebase left half-way stops the commit too: committing in the middle of
 *   one would splice this work into the commit being replayed.
 * - A rejected commit (e.g. a pre-commit hook) throws with git's output, which
 *   the Tasks workspace shows on the card and hands back to the agent.
 *
 * `generateMessage` may be slow or fail (it calls a model); `fallbackMessage`
 * is used then, so a commit never fails for want of a message.
 */
export const commitTaskStepWork = async (
  projectPath,
  { fallbackMessage = "", generateMessage = null } = {},
) => {
  if (!(await isGitCheckout(projectPath))) {
    // Without this, the first git command fails with a page of usage text.
    // It is also a different kind of failure: the agent cannot fix it, so the
    // caller offers to recreate the worktree instead of retrying the step.
    throw createTaskWorktreeMissingError(projectPath);
  }

  if (await isRebaseInProgress(projectPath)) {
    throw new Error(
      "A rebase is still in progress. Finish it with `git rebase --continue`, or abort it with `git rebase --abort`.",
    );
  }

  const unmerged = await runGitCommand(projectPath, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  const unmergedPaths = unmerged.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (unmergedPaths.length > 0) {
    throw new Error(
      `Unresolved merge conflicts in: ${unmergedPaths.join(", ")}. Resolve them and stage the files with \`git add\`.`,
    );
  }

  await runGitCommand(projectPath, ["add", "-A", "--", "."]);

  if (await isMergeInProgress(projectPath)) {
    await runGitCommand(projectPath, ["commit", "--no-edit"]);
    return {
      commitHash: await readShortHead(projectPath),
      commitMessage: null,
      committed: true,
      merge: true,
    };
  }

  const staged = await runGitCommand(
    projectPath,
    ["diff", "--cached", "--quiet"],
    { allowFailure: true },
  );
  if (staged.ok) {
    return {
      commitHash: null,
      commitMessage: null,
      committed: false,
      merge: false,
    };
  }

  let generated = "";
  if (generateMessage) {
    try {
      generated = toSubjectLine(await generateMessage());
    } catch (error) {
      console.warn("[git] task commit message generation failed:", error);
    }
  }
  const commitMessage =
    generated || toSubjectLine(fallbackMessage) || "Task step work";

  await runGitCommand(projectPath, ["commit", "-m", commitMessage]);
  return {
    commitHash: await readShortHead(projectPath),
    commitMessage,
    committed: true,
    merge: false,
  };
};
