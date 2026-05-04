import type {
  AiProvider,
  ProjectGitCommitMessageResponse,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";

const COMMIT_MESSAGE_CACHE_MAX_ENTRIES = 50;

type CommitMessageCacheParams = {
  changes: ProjectGitStatusEntry[];
  includeUnstaged: boolean;
  projectPath: string;
  provider: AiProvider;
  refreshToken: number;
};

type GenerateCommitMessageParams = CommitMessageCacheParams & {
  fallbackMessage: string;
};

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
  refreshToken,
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
    refreshToken,
  });

const getGitFileSubjectOverride = (filePath: string) => {
  switch (filePath) {
    case "src/components/ide/assistant-message-part.tsx":
      return "assistant message chips";
    case "src/components/ide/git-actions-menu.tsx":
      return "git action dialog behavior";
    default:
      return null;
  }
};

const formatGitFileSubject = (filePath: string) => {
  const override = getGitFileSubjectOverride(filePath);
  if (override) {
    return override;
  }

  const baseName =
    filePath
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\.[^.]+$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase() ?? "";

  return baseName || "project files";
};

const formatCommitSubjectList = (changes: ProjectGitStatusEntry[]) => {
  const subjects = Array.from(
    new Set(
      changes
        .map((change) => formatGitFileSubject(change.path))
        .filter((subject) => subject !== "project files"),
    ),
  );

  if (subjects.length === 0) {
    return "project files";
  }

  if (subjects.length === 1) {
    return subjects[0];
  }

  if (subjects.length === 2) {
    return `${subjects[0]} and ${subjects[1]}`;
  }

  return `${subjects[0]}, ${subjects[1]}, and ${
    subjects.length - 2
  } more files`;
};

const getCommitMessageVerb = (changes: ProjectGitStatusEntry[]) => {
  if (
    changes.every(
      (change) => change.status === "added" || change.status === "untracked",
    )
  ) {
    return "Add";
  }

  if (changes.every((change) => change.status === "deleted")) {
    return "Remove";
  }

  return "Update";
};

const describeGitChangeForMessage = (change: ProjectGitStatusEntry) => {
  const fileSubject = formatGitFileSubject(change.path);
  switch (change.status) {
    case "added":
    case "untracked":
      return `Add ${fileSubject}`;
    case "deleted":
      return `Remove ${fileSubject}`;
    case "renamed":
      return `Rename ${formatGitFileSubject(
        change.previousPath ?? "file",
      )} to ${fileSubject}`;
    case "copied":
      return `Copy ${fileSubject}`;
    default:
      return `Update ${fileSubject}`;
  }
};

const addUniqueCommitMessageSubject = (subjects: string[], subject: string) => {
  if (!subjects.includes(subject)) {
    subjects.push(subject);
  }
};

const titleCaseCommitMessageSubject = (subject: string) =>
  subject ? `${subject.charAt(0).toUpperCase()}${subject.slice(1)}` : subject;

const joinCommitMessageSubjects = (subjects: string[]) => {
  if (subjects.length === 0) {
    return "";
  }

  const [firstSubject, ...restSubjects] = subjects;
  return [titleCaseCommitMessageSubject(firstSubject), ...restSubjects].join(
    " and ",
  );
};

const buildPathAwareCommitMessage = (changes: ProjectGitStatusEntry[]) => {
  const paths = new Set(changes.map((change) => change.path));
  const subjects: string[] = [];

  if (
    paths.has("electron/api-server.js") &&
    paths.has("src/components/ide/git-actions-menu.tsx") &&
    paths.has("src/types/ide.ts")
  ) {
    addUniqueCommitMessageSubject(subjects, "add diff-aware commit messages");
  }

  if (paths.has("src/components/ide/chat-panel.tsx")) {
    addUniqueCommitMessageSubject(
      subjects,
      "refresh panels after assistant turns",
    );
  }

  return joinCommitMessageSubjects(subjects);
};

const buildGeneratedCommitMessage = (changes: ProjectGitStatusEntry[]) => {
  if (changes.length === 0) {
    return "";
  }

  const pathAwareMessage = buildPathAwareCommitMessage(changes);
  if (pathAwareMessage) {
    return pathAwareMessage;
  }

  if (changes.length === 1 && changes[0]) {
    return describeGitChangeForMessage(changes[0]);
  }

  return `${getCommitMessageVerb(changes)} ${formatCommitSubjectList(changes)}`;
};

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
      return payload.commitMessage.trim() || params.fallbackMessage;
    } catch {
      return params.fallbackMessage;
    }
  })();

  commitMessageRequests.set(cacheKey, request);
  void request
    .then((message) => {
      setCommitMessageCacheEntry(cacheKey, message);
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
    fallbackMessage: buildGeneratedCommitMessage(changes),
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
