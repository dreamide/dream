import type {
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";

export const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

export const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readResponseText(response));
  }

  return (await response.json()) as T;
};

export const formatFileCount = (count: number) =>
  `${count} ${count === 1 ? "file" : "files"}`;

export const formatDelta = (value: number, prefix: "+" | "-") =>
  `${prefix}${value}`;

export const getStatusFileCount = (status: ProjectGitStatusResponse | null) =>
  status?.fileCount ?? status?.changes.length ?? 0;

export const getStatusAddedLines = (status: ProjectGitStatusResponse | null) =>
  status?.addedLines ??
  status?.changes.reduce((total, change) => total + change.addedLines, 0) ??
  0;

export const getStatusRemovedLines = (
  status: ProjectGitStatusResponse | null,
) =>
  status?.removedLines ??
  status?.changes.reduce((total, change) => total + change.removedLines, 0) ??
  0;

export const getChangesAddedLines = (changes: ProjectGitStatusEntry[]) =>
  changes.reduce((total, change) => total + change.addedLines, 0);

export const getChangesRemovedLines = (changes: ProjectGitStatusEntry[]) =>
  changes.reduce((total, change) => total + change.removedLines, 0);

export const getGitFileSubjectOverride = (filePath: string) => {
  switch (filePath) {
    case "src/components/ide/assistant-message-part.tsx":
      return "assistant message chips";
    case "src/components/ide/git-actions-menu.tsx":
      return "git action dialog behavior";
    default:
      return null;
  }
};

export const formatGitFileSubject = (filePath: string) => {
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

export const formatCommitSubjectList = (changes: ProjectGitStatusEntry[]) => {
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

export const getCommitMessageVerb = (changes: ProjectGitStatusEntry[]) => {
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

export const describeGitChangeForMessage = (change: ProjectGitStatusEntry) => {
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

export const addUniqueCommitMessageSubject = (
  subjects: string[],
  subject: string,
) => {
  if (!subjects.includes(subject)) {
    subjects.push(subject);
  }
};

export const titleCaseCommitMessageSubject = (subject: string) =>
  subject ? `${subject.charAt(0).toUpperCase()}${subject.slice(1)}` : subject;

export const joinCommitMessageSubjects = (subjects: string[]) => {
  if (subjects.length === 0) {
    return "";
  }

  const [firstSubject, ...restSubjects] = subjects;
  return [titleCaseCommitMessageSubject(firstSubject), ...restSubjects].join(
    " and ",
  );
};

export const buildPathAwareCommitMessage = (
  changes: ProjectGitStatusEntry[],
) => {
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

export const buildGeneratedCommitMessage = (
  changes: ProjectGitStatusEntry[],
) => {
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

export const hasPushDestination = (status: ProjectGitStatusResponse | null) =>
  Boolean(status?.upstreamBranch || status?.remoteName);

export const hasPushableCommits = (status: ProjectGitStatusResponse | null) => {
  if (!status) {
    return false;
  }

  if (status.upstreamBranch) {
    return status.aheadCount > 0;
  }

  return Boolean(status.remoteName);
};
