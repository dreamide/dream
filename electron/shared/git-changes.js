// @ts-check
// A project's changed files as far as generated git text is concerned, on
// both sides of the route seam: which changes a commit takes, and which
// fields of a change make two sets of changes the same set.
//
// The host caches a generated commit message by these changes (their
// fingerprint, project-git/generated-text.js); the renderer caches what it has
// already been told by the same changes (git-generated-text.ts). Both use
// this module, so they agree on when a message is still the right one.

/**
 * @typedef {{
 *   addedLines: number,
 *   path: string,
 *   previousPath: string | null,
 *   removedLines: number,
 *   staged: boolean,
 *   status: string,
 *   unstaged: boolean,
 * }} GitChange
 */

/**
 * The changes a commit takes: the staged ones, plus the unstaged ones when
 * it includes them.
 * @template {Pick<GitChange, "staged" | "unstaged">} Change
 * @param {readonly Change[] | null | undefined} changes
 * @param {boolean} includeUnstaged
 * @returns {Change[]}
 */
export const selectCommitChanges = (changes, includeUnstaged) =>
  (changes ?? []).filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  );

/**
 * The fields that identify a set of changes, in path order, without anything
 * else a status entry carries.
 * @param {readonly GitChange[]} changes
 * @returns {GitChange[]}
 */
const canonicalGitChanges = (changes) =>
  changes
    .map((change) => ({
      addedLines: change.addedLines,
      path: change.path,
      previousPath: change.previousPath,
      removedLines: change.removedLines,
      staged: change.staged,
      status: change.status,
      unstaged: change.unstaged,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

/**
 * A stable text for these changes and every option that shapes what is
 * generated from them. Options are taken whole (in key order), so a new
 * option cannot be left out of the key.
 * @param {readonly GitChange[]} changes
 * @param {Record<string, unknown>} options
 * @returns {string}
 */
export const gitChangesKey = (changes, options) =>
  JSON.stringify({
    changes: canonicalGitChanges(changes),
    options: Object.fromEntries(
      Object.entries(options)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  });

/**
 * @typedef {{
 *   addedLines: number,
 *   fileCount: number,
 *   hasStagedChanges: boolean,
 *   hasUnstagedChanges: boolean,
 *   removedLines: number,
 *   stagedCount: number,
 *   unstagedCount: number,
 * }} GitChangesSummary
 */

/**
 * The totals a git status reports over its changes.
 * @param {readonly Partial<GitChange>[]} changes
 * @returns {GitChangesSummary}
 */
export const summarizeGitChanges = (changes) =>
  changes.reduce(
    /**
     * @param {GitChangesSummary} current
     * @param {Partial<GitChange>} change
     * @returns {GitChangesSummary}
     */
    (current, change) => ({
      addedLines: current.addedLines + (change.addedLines ?? 0),
      fileCount: current.fileCount + 1,
      hasStagedChanges: current.hasStagedChanges || Boolean(change.staged),
      hasUnstagedChanges:
        current.hasUnstagedChanges || Boolean(change.unstaged),
      removedLines: current.removedLines + (change.removedLines ?? 0),
      stagedCount: current.stagedCount + (change.staged ? 1 : 0),
      unstagedCount: current.unstagedCount + (change.unstaged ? 1 : 0),
    }),
    {
      addedLines: 0,
      fileCount: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      removedLines: 0,
      stagedCount: 0,
      unstagedCount: 0,
    },
  );

/** What a summary status read leaves out: everything optional. */
export const SUMMARY_GIT_STATUS_DETAIL = Object.freeze({
  includeMetadata: false,
  includeStats: false,
  includeUntracked: false,
});

/**
 * `status` as a read with less `detail` would have reported it: without
 * untracked files, line counts or upstream and remote details, as asked.
 * The host answers a less detailed read from a full one with it, and so
 * does the renderer's resource cache, so both agree on what a summary is.
 * @template {{ isRepo: boolean, changes: Partial<GitChange>[] }} Status
 * @param {Status} status
 * @param {{ includeMetadata: boolean, includeStats: boolean, includeUntracked: boolean }} detail
 * @returns {Status}
 */
export const narrowGitStatus = (status, detail) => {
  if (!status.isRepo) return status;
  const changes = status.changes
    .filter(
      (change) => detail.includeUntracked || change.status !== "untracked",
    )
    .map((change) =>
      detail.includeStats
        ? change
        : { ...change, addedLines: 0, removedLines: 0 },
    );
  return {
    ...status,
    ...(detail.includeMetadata
      ? {}
      : {
          aheadCount: 0,
          baseBranch: null,
          behindCount: 0,
          remoteName: null,
          upstreamBranch: null,
        }),
    changes,
    ...summarizeGitChanges(changes),
  };
};
