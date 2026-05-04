export const getGitFileSubjectOverride = (filePath) => {
  switch (filePath) {
    case "src/components/ide/assistant-message-part.tsx":
      return "assistant message chips";
    case "src/components/ide/git-actions-menu.tsx":
      return "git action dialog behavior";
    default:
      return null;
  }
};

export const formatGitFileSubject = (filePath) => {
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

export const formatCommitSubjectList = (changes) => {
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

export const getCommitMessageVerb = (changes) => {
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

export const describeGitChangeForMessage = (change) => {
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

export const buildPathAwareCommitMessage = (changes) => {
  const paths = new Set(changes.map((change) => change.path));

  const touchesApiRouteComposition =
    paths.has("electron/api/app.js") ||
    paths.has("electron/api-server.js") ||
    paths.has("electron/api/chat-routes.js") ||
    paths.has("electron/api/provider-routes.js") ||
    paths.has("electron/api/project-git-routes.js");
  const addsApiModules = Array.from(paths).some(
    (filePath) =>
      filePath.startsWith("electron/api/chat/") ||
      filePath.startsWith("electron/api/providers/") ||
      filePath.startsWith("electron/api/project-git/") ||
      filePath.startsWith("electron/api/shared/"),
  );

  if (touchesApiRouteComposition && addsApiModules) {
    return "Modularize Electron API server routes";
  }

  if (
    paths.has("electron/api/project-git/actions.js") &&
    paths.has("electron/api/project-git/core.js")
  ) {
    return "Fix project Git push preview metadata";
  }

  return "";
};

export const buildGeneratedCommitMessage = (
  changes,
  customInstructions = "",
) => {
  const pathAwareMessage = buildPathAwareCommitMessage(changes);
  if (pathAwareMessage) {
    return pathAwareMessage;
  }

  if (changes.length === 1 && changes[0]) {
    return describeGitChangeForMessage(changes[0]);
  }

  const subject =
    changes.length > 0
      ? `${getCommitMessageVerb(changes)} ${formatCommitSubjectList(changes)}`
      : "Update project files";

  if (customInstructions.trim().toLowerCase().includes("conventional")) {
    return `chore: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
  }

  return subject;
};
