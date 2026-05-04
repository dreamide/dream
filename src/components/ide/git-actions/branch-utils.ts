const normalizeBranchComparisonName = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "");
};

export const getPullRequestBranchError = (
  headBranch: string | null,
  baseBranch: string,
) => {
  const normalizedHead = normalizeBranchComparisonName(headBranch);
  const normalizedBase = normalizeBranchComparisonName(baseBranch);

  if (!normalizedHead) {
    return "Cannot create a pull request from a detached HEAD.";
  }

  if (normalizedBase && normalizedHead === normalizedBase) {
    return `Cannot create a pull request from ${headBranch} to ${baseBranch}. Push changes instead, or switch to a feature branch.`;
  }

  return null;
};

export const formatCommitDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
};
