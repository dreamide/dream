import type {
  AiProvider,
  ProjectGitCreatePrNextStep,
  ProjectGitPullRequestDetailsResponse,
  ProjectGitStatusEntry,
} from "@/types/ide";

const PULL_REQUEST_DETAILS_CACHE_MAX_ENTRIES = 50;
const PULL_REQUEST_DETAILS_CACHE_VERSION = 1;

type PullRequestDetailsCacheParams = {
  baseBranch: string;
  branch: string | null;
  changes: ProjectGitStatusEntry[];
  includeUnstaged: boolean;
  model: string;
  nextStep: ProjectGitCreatePrNextStep;
  projectPath: string;
  provider: AiProvider;
  refreshToken: number;
};

type PullRequestDetails = ProjectGitPullRequestDetailsResponse;

const emptyPullRequestDetails: PullRequestDetails = {
  baseBranch: "",
  commitMessage: null,
  description: "",
  headBranch: "",
  title: "",
};

const pullRequestDetailsCache = new Map<string, PullRequestDetails>();
const pullRequestDetailsRequests = new Map<
  string,
  Promise<PullRequestDetails>
>();

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const setPullRequestDetailsCacheEntry = (
  key: string,
  value: PullRequestDetails,
) => {
  pullRequestDetailsCache.set(key, value);
  if (pullRequestDetailsCache.size <= PULL_REQUEST_DETAILS_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = pullRequestDetailsCache.keys().next().value;
  if (oldestKey) {
    pullRequestDetailsCache.delete(oldestKey);
  }
};

const getPullRequestDetailsCacheKey = ({
  baseBranch,
  branch,
  changes,
  includeUnstaged,
  model,
  nextStep,
  projectPath,
  provider,
  refreshToken,
}: PullRequestDetailsCacheParams) =>
  JSON.stringify({
    baseBranch,
    branch,
    changes: changes
      .map((change) => ({
        addedLines: change.addedLines,
        path: change.path,
        previousPath: change.previousPath,
        removedLines: change.removedLines,
        staged: change.staged,
        status: change.status,
        unstaged: change.unstaged,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    includeUnstaged,
    model,
    nextStep,
    projectPath,
    provider,
    refreshToken,
    version: PULL_REQUEST_DETAILS_CACHE_VERSION,
  });

export const getCachedProjectPullRequestDetails = (
  params: PullRequestDetailsCacheParams,
) => pullRequestDetailsCache.get(getPullRequestDetailsCacheKey(params));

export const generateCachedProjectPullRequestDetails = (
  params: PullRequestDetailsCacheParams,
) => {
  const cacheKey = getPullRequestDetailsCacheKey(params);
  const cachedDetails = pullRequestDetailsCache.get(cacheKey);
  if (cachedDetails !== undefined) {
    return Promise.resolve(cachedDetails);
  }

  const existingRequest = pullRequestDetailsRequests.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const response = await fetch("/api/project-git-pull-request-details", {
        body: JSON.stringify({
          baseBranch: params.baseBranch,
          includeUnstaged: params.includeUnstaged,
          model: params.model,
          nextStep: params.nextStep,
          projectPath: params.projectPath,
          provider: params.provider,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      return (await response.json()) as ProjectGitPullRequestDetailsResponse;
    } catch {
      return emptyPullRequestDetails;
    }
  })();

  pullRequestDetailsRequests.set(cacheKey, request);
  void request
    .then((details) => {
      if (details.title || details.description) {
        setPullRequestDetailsCacheEntry(cacheKey, details);
      }
    })
    .finally(() => {
      if (pullRequestDetailsRequests.get(cacheKey) === request) {
        pullRequestDetailsRequests.delete(cacheKey);
      }
    });

  return request;
};
