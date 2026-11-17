// Deleting a local branch. "Merged" is answered in one place: every commit of
// the branch is in the repository's base branch, locally or on its remote
// (both refs of the base, repository-context.js `baseOf`). A
// branch that is not merged is only deleted against a confirmed head: the
// commit the person saw when they agreed to lose its work, so a branch that
// moved since then is kept.
import path from "node:path";
import { RouteError } from "../shared/json-route.js";
import {
  getGitCommandErrorMessage,
  getGitRepositoryInfo,
  gitRepositories,
  listProjectGitBranches,
  runGitCommand,
} from "./core.js";
import { gitHubPullRequests, pullRequestSummary } from "./pull-requests.js";

/**
 * The pull request that belongs to `branch` (the same rule as the PR panel,
 * project-git/pull-requests.js), or `null` when there is none or GitHub
 * cannot say (not logged in, no GitHub remote, ...).
 */
export const readBranchPullRequest = async (cwd, branch) => {
  try {
    const pr = await gitHubPullRequests.branchPullRequest(cwd, branch);
    if (!pr) {
      return null;
    }
    const { state } = pullRequestSummary(pr);
    return {
      isDraft: pr.draft === true,
      mergedAt: typeof pr.merged_at === "string" ? pr.merged_at : null,
      number: pr.number,
      state:
        state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      url: typeof pr.html_url === "string" ? pr.html_url : "",
    };
  } catch {
    return null;
  }
};

const countCommits = (cwd, branch, excludedRefs) =>
  gitRepositories.count(cwd, [
    `refs/heads/${branch}`,
    "--not",
    ...excludedRefs,
  ]);

/**
 * How much of `branch` would be lost with it. `unmergedCount` is the commits
 * not in the base branch, null when there is no other base to compare with;
 * `localOnlyCount` is those that are on no remote either.
 */
const readBranchMergeState = async (cwd, branch, base) => {
  const baseRefs =
    base && base.baseBranch !== branch
      ? [base.localRef, base.remoteRef].filter((ref) => ref !== null)
      : [];

  const [unmergedCount, localOnlyCount] = await Promise.all([
    baseRefs.length > 0 ? countCommits(cwd, branch, baseRefs) : null,
    countCommits(cwd, branch, [...baseRefs, "--remotes"]),
  ]);

  return {
    baseBranch: base?.baseBranch ?? null,
    localOnlyCount,
    remoteName: await gitRepositories.remoteName(cwd),
    unmergedCount,
  };
};

const readBranchHead = (cwd, branch) =>
  gitRepositories.ref(cwd, `refs/heads/${branch}`);

const runBranchDelete = async (cwd, flag, branch) => {
  const result = await runGitCommand(cwd, ["branch", flag, "--", branch], {
    allowFailure: true,
  });
  return {
    branchDeleted: result.ok,
    branchDeleteError: result.ok
      ? null
      : getGitCommandErrorMessage(result.error),
  };
};

const refusedDelete = (branchDeleteError) => ({
  branchDeleted: false,
  branchDeleteError,
});

/**
 * Deletes `branch`, answering how that went rather than throwing.
 *
 * With `confirmedHead` it goes however unmerged the branch is, as long as the
 * branch is still at that commit. Without one it goes only when merged: git's
 * own check first, which also looks at the upstream and the checkout it runs
 * in, then the base branch, which git does not know is the one that matters.
 */
export const deleteGitBranch = async (
  cwd,
  branch,
  { confirmedHead = null } = {},
) => {
  const base = await gitRepositories.baseOf(cwd);
  if (branch === base?.baseBranch) {
    return refusedDelete(`"${branch}" is the base branch.`);
  }

  if (confirmedHead) {
    const head = await readBranchHead(cwd, branch);
    if (head !== confirmedHead) {
      return refusedDelete(
        `"${branch}" changed after it was reviewed. Review it again before deleting it.`,
      );
    }
    return runBranchDelete(cwd, "-D", branch);
  }

  const deletion = await runBranchDelete(cwd, "-d", branch);
  if (deletion.branchDeleted) {
    return deletion;
  }
  const { unmergedCount } = await readBranchMergeState(cwd, branch, base);
  return unmergedCount === 0 ? runBranchDelete(cwd, "-D", branch) : deletion;
};

const isSamePath = (left, right) =>
  path.relative(path.resolve(left), path.resolve(right)) === "";

const readListedBranch = async (projectPath, branchName) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }
  const { branches } = await listProjectGitBranches(projectPath);
  const entry = branches.find((branch) => branch.name === branchName);
  if (!entry) {
    throw new RouteError(`Branch "${branchName}" does not exist.`, 404);
  }
  return { entry, repoRoot: repoInfo.repoRoot };
};

/**
 * What deleting a branch would cost, and what stands in its way. With
 * `removingWorktreePath`, the question is asked on behalf of removing that
 * worktree, so its checkout of the branch does not count against the delete.
 */
export const previewProjectGitBranchDelete = async (
  projectPath,
  { branchName, removingWorktreePath = null },
) => {
  const { entry, repoRoot } = await readListedBranch(projectPath, branchName);
  const [head, mergeState] = await Promise.all([
    readBranchHead(repoRoot, branchName),
    gitRepositories
      .baseOf(repoRoot)
      .then((base) => readBranchMergeState(repoRoot, branchName, base)),
  ]);
  const pullRequest =
    mergeState.remoteName && mergeState.unmergedCount !== 0
      ? await readBranchPullRequest(repoRoot, branchName)
      : null;
  const removingItsCheckout =
    Boolean(removingWorktreePath) &&
    entry.checkedOutAt !== null &&
    isSamePath(entry.checkedOutAt, removingWorktreePath);

  return {
    baseBranch: mergeState.baseBranch,
    blockedReason:
      removingItsCheckout && entry.deleteBlockedReason === "current"
        ? null
        : entry.deleteBlockedReason,
    branch: branchName,
    checkedOutAt: removingItsCheckout ? null : entry.checkedOutAt,
    head,
    localOnlyCount: mergeState.localOnlyCount,
    pullRequest,
    unmergedCount: mergeState.unmergedCount,
  };
};

const BLOCKED_DELETE_MESSAGES = {
  base: (branch) => `"${branch}" is the base branch.`,
  current: (branch) => `"${branch}" is the current branch.`,
  "main-checkout": (branch) => `"${branch}" is open in the main checkout.`,
};

/** Deletes a branch nothing has checked out; answers the branch list. */
export const deleteProjectGitBranch = async (
  projectPath,
  { branchName, confirmedHead = null },
) => {
  const { entry, repoRoot } = await readListedBranch(projectPath, branchName);
  if (entry.deleteBlockedReason) {
    throw new RouteError(
      BLOCKED_DELETE_MESSAGES[entry.deleteBlockedReason](branchName),
      409,
    );
  }
  if (entry.checkedOutAt) {
    throw new RouteError(
      `"${branchName}" is checked out at ${entry.checkedOutAt}.`,
      409,
    );
  }

  const { branchDeleted, branchDeleteError } = await deleteGitBranch(
    repoRoot,
    branchName,
    { confirmedHead },
  );
  if (!branchDeleted) {
    throw new RouteError(branchDeleteError, 409);
  }
  return {
    ...(await listProjectGitBranches(projectPath)),
    deleted: branchName,
  };
};
