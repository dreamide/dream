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
  messages: {
    detachedHead: string;
    sameBranch: (values: { base: string; head: string }) => string;
  },
) => {
  const normalizedHead = normalizeBranchComparisonName(headBranch);
  const normalizedBase = normalizeBranchComparisonName(baseBranch);

  if (!normalizedHead) {
    return messages.detachedHead;
  }

  if (normalizedBase && normalizedHead === normalizedBase) {
    return messages.sameBranch({ base: baseBranch, head: headBranch ?? "" });
  }

  return null;
};
