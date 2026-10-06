import { apiClient } from "@/lib/api-client";
import type {
  AiProvider,
  ModelSpeed,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
  ReasoningEffort,
} from "@/types/ide";
import { projectResourceKey, readProjectResource } from "./project-resources";

const COMMIT_MESSAGE_CACHE_MAX_ENTRIES = 50;
const COMMIT_MESSAGE_CACHE_VERSION = 3;

type CommitMessageCacheParams = {
  changes: ProjectGitStatusEntry[];
  includeUnstaged: boolean;
  model: string;
  modelSpeed: ModelSpeed;
  projectPath: string;
  provider: AiProvider;
  reasoningEffort: ReasoningEffort | null;
  refreshToken: number;
};

type GenerateCommitMessageParams = CommitMessageCacheParams;

type WarmCommitMessageParams = {
  /** The project's host (absent: the local host). */
  hostId?: string;
  includeUnstaged?: boolean;
  model: string;
  modelSpeed: ModelSpeed;
  projectPath: string;
  provider: AiProvider;
  reasoningEffort: ReasoningEffort | null;
  refreshToken: number;
};

type WarmCommitMessageForStatusParams = WarmCommitMessageParams & {
  status: ProjectGitStatusResponse | null;
};

const commitMessageCache = new Map<string, string>();
const commitMessageRequests = new Map<string, Promise<string>>();

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
  model,
  modelSpeed,
  projectPath,
  provider,
  reasoningEffort,
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
    model,
    modelSpeed,
    projectPath,
    provider,
    reasoningEffort,
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
    const payload = await apiClient.gitCommitMessage({
      includeUnstaged: params.includeUnstaged,
      model: params.model,
      modelSpeed: params.modelSpeed,
      projectPath: params.projectPath,
      provider: params.provider,
      reasoningEffort: params.reasoningEffort,
    });
    return payload.commitMessage.trim();
  })();

  commitMessageRequests.set(cacheKey, request);
  void request
    .then((message) => {
      if (message) {
        setCommitMessageCacheEntry(cacheKey, message);
      }
    })
    .catch(() => {
      // Callers decide whether generation failures should be shown or ignored.
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
  model,
  modelSpeed,
  projectPath,
  provider,
  reasoningEffort,
  refreshToken,
  status,
}: WarmCommitMessageForStatusParams) => {
  try {
    const changes = getCommitChanges(status, includeUnstaged);
    if (changes.length === 0) {
      return "";
    }

    return await generateCachedProjectCommitMessage({
      changes,
      includeUnstaged,
      model,
      modelSpeed,
      projectPath,
      provider,
      reasoningEffort,
      refreshToken,
    });
  } catch {
    return "";
  }
};

export const warmProjectCommitMessage = async ({
  hostId,
  includeUnstaged = true,
  model,
  modelSpeed,
  projectPath,
  provider,
  reasoningEffort,
  refreshToken,
}: WarmCommitMessageParams) => {
  try {
    return await warmProjectCommitMessageForStatus({
      includeUnstaged,
      model,
      modelSpeed,
      projectPath,
      provider,
      reasoningEffort,
      refreshToken,
      // The project's full status at its current refresh, from the project
      // resources: the changes panel's read when it is open.
      status: await readProjectResource(
        projectResourceKey("gitStatus", projectPath, {
          hostId,
          params: { detail: "full" },
        }),
      ),
    });
  } catch {
    return "";
  }
};
