import {
  getGitRepositoryInfo,
  gitRefExists,
  resolveGitBranchUpstream,
  runGitCommand,
} from "./core.js";

const requireRepoRoot = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }
  return repoInfo.repoRoot;
};

/**
 * Where a branch stands against its remote, from the refs already in the
 * repository: nothing is fetched, so this never touches the network.
 *
 * `pushed` answers "has `commit` reached the remote?", which is what a finished
 * task wants to know: merging is local, so a task can be done and still exist
 * on one machine only. It is `null` when that cannot be known.
 *
 * Reading the status never pushes. The task card pushes through the regular
 * push dialog, naming the branch (see `pushProjectGitChanges`).
 */
export const getTaskDeliveryStatus = async (
  projectPath,
  { branch, commit = null },
) => {
  const repoRoot = await requireRepoRoot(projectPath);
  const branchExists = await gitRefExists(repoRoot, `refs/heads/${branch}`);
  const upstream = branchExists
    ? await resolveGitBranchUpstream(repoRoot, branch)
    : null;
  const upstreamKnown =
    upstream !== null && (await gitRefExists(repoRoot, upstream.ref));
  if (!upstream || !upstreamKnown) {
    return {
      aheadCount: 0,
      behindCount: 0,
      branch,
      branchExists,
      pushed: null,
      upstream: upstream?.upstream ?? null,
    };
  }

  const counts = await runGitCommand(repoRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `${upstream.ref}...refs/heads/${branch}`,
  ]);
  const [behindCount = 0, aheadCount = 0] = counts.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10) || 0);

  let pushed = aheadCount === 0;
  if (commit) {
    const contained = await runGitCommand(
      repoRoot,
      ["merge-base", "--is-ancestor", commit, upstream.ref],
      { allowFailure: true },
    );
    // Exit 1 means "not an ancestor"; anything else (an unknown commit) means
    // it cannot be told.
    pushed = contained.ok ? true : contained.error?.code === 1 ? false : null;
  }

  return {
    aheadCount,
    behindCount,
    branch,
    branchExists,
    pushed,
    upstream: upstream.upstream,
  };
};
