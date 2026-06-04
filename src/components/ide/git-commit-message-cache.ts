import type {
  AiProvider,
  ProjectGitCommitMessageResponse,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";

const COMMIT_MESSAGE_CACHE_MAX_ENTRIES = 50;
const COMMIT_MESSAGE_CACHE_VERSION = 3;

type CommitMessageCacheParams = {
  changes: ProjectGitStatusEntry[];
  includeUnstaged: boolean;
  projectPath: string;
  provider: AiProvider;
  refreshToken: number;
};

type GenerateCommitMessageParams = CommitMessageCacheParams;

type WarmCommitMessageParams = {
  includeUnstaged?: boolean;
  projectPath: string;
  provider: AiProvider;
  refreshToken: number;
};

type WarmCommitMessageForStatusParams = WarmCommitMessageParams & {
  status: ProjectGitStatusResponse | null;
};

const commitMessageCache = new Map<string, string>();
const commitMessageRequests = new Map<string, Promise<string>>();

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

export const getCommitChanges = (
  status: ProjectGitStatusResponse | null,
  includeUnstaged: boolean,
) =>
  status?.changes.filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  ) ?? [];

const setCommitMessageCacheEntry = (key: string, value: string) => {
  commitMessageCache.set(key, value);
  if (commitMessageCache.size <= COMMIT_MESSAGE_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = commitMessageCache.keys().next().value;
  if (oldestKey) {
    commitMessageCache.delete(oldestKey);
  }
};

const getCommitMessageCacheKey = ({
  changes,
  includeUnstaged,
  projectPath,
  provider,
}: CommitMessageCacheParams) =>
  JSON.stringify({
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
    projectPath,
    provider,
    version: COMMIT_MESSAGE_CACHE_VERSION,
  });

export const getCachedProjectCommitMessage = (
  params: CommitMessageCacheParams,
) => commitMessageCache.get(getCommitMessageCacheKey(params));

export const generateCachedProjectCommitMessage = (
  params: GenerateCommitMessageParams,
) => {
  const cacheKey = getCommitMessageCacheKey(params);
  const cachedMessage = commitMessageCache.get(cacheKey);
  if (cachedMessage !== undefined) {
    return Promise.resolve(cachedMessage);
  }

  const existingRequest = commitMessageRequests.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const response = await fetch("/api/project-git-commit-message", {
        body: JSON.stringify({
          includeUnstaged: params.includeUnstaged,
          projectPath: params.projectPath,
          provider: params.provider,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      const payload =
        (await response.json()) as ProjectGitCommitMessageResponse;
      return payload.commitMessage.trim();
    } catch {
      return "";
    }
  })();

  commitMessageRequests.set(cacheKey, request);
  void request
    .then((message) => {
      if (message) {
        setCommitMessageCacheEntry(cacheKey, message);
      }
    })
    .finally(() => {
      if (commitMessageRequests.get(cacheKey) === request) {
        commitMessageRequests.delete(cacheKey);
      }
    });

  return request;
};

export const warmProjectCommitMessageForStatus = async ({
  includeUnstaged = true,
  projectPath,
  provider,
  refreshToken,
  status,
}: WarmCommitMessageForStatusParams) => {
  const changes = getCommitChanges(status, includeUnstaged);
  if (changes.length === 0) {
    return "";
  }

  return await generateCachedProjectCommitMessage({
    changes,
    includeUnstaged,
    projectPath,
    provider,
    refreshToken,
  });
};

export const warmProjectCommitMessage = async ({
  includeUnstaged = true,
  projectPath,
  provider,
  refreshToken,
}: WarmCommitMessageParams) => {
  try {
    const statusResponse = await fetch("/api/project-git-status", {
      body: JSON.stringify({ projectPath }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!statusResponse.ok) {
      throw new Error(await readResponseText(statusResponse));
    }

    return await warmProjectCommitMessageForStatus({
      includeUnstaged,
      projectPath,
      provider,
      refreshToken,
      status: (await statusResponse.json()) as ProjectGitStatusResponse,
    });
  } catch {
    return "";
  }
};
