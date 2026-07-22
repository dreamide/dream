import type {
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";

export const readResponseText = async (
  response: Response,
  fallback: string,
): Promise<string> => {
  const text = await response.text();
  return text.trim() || fallback;
};

export const postJson = async <T>(
  url: string,
  body: unknown,
  fallback: string,
): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readResponseText(response, fallback));
  }

  return (await response.json()) as T;
};

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
