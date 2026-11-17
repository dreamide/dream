import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import type {
  ProjectGitChangeStatus,
  ProjectGitStatusEntry,
} from "@/types/ide";

/**
 * How the Files tree marks a changed file, VS Code style: a coloured name and
 * a status letter, with the folders above it marked as holding changes. The
 * tree has no "copied" status; a copy is a new file, so it shows as added.
 */
const TREE_GIT_STATUS: Record<ProjectGitChangeStatus, GitStatus> = {
  added: "added",
  copied: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  untracked: "untracked",
};

/** The project's changed files (paths relative to it) as the tree's entries. */
export const toFileTreeGitStatus = (
  changes: readonly ProjectGitStatusEntry[],
): GitStatusEntry[] =>
  changes.map((change) => ({
    path: change.path,
    status: TREE_GIT_STATUS[change.status],
  }));
