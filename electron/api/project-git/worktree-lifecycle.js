// The lifecycle of a linked git worktree as Dream manages it: list the
// worktrees of a repository, create one on a new branch, compare and merge
// its branch back into its base, and forget it (remove the checkout, the
// branch once merged, and what Dream kept for the directory).
//
// Every step runs over the one git runner in core.js. Compare, merge and
// forget resolve the worktree the same way, so "which repository, which
// branch, which main checkout" is answered in one place.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHostDataDirectory } from "../../host/host-paths.js";
import {
  forgetProjectDirectory,
  releaseProjectDirectory,
} from "../project-resources.js";
import { RouteError } from "../shared/json-route.js";
import {
  getPullRequestBaseRef,
  readGitCommitCount,
  readGitPushPreviewCommits,
} from "./actions.js";
import {
  getGitAheadBehindCounts,
  getGitCommandErrorMessage,
  getGitRepositoryInfo,
  getProjectGitMetadata,
  gitRefExists,
  gitRepositories,
  listProjectGitChanges,
  parseSingleFileDiff,
  runGhCommand,
  runGitCommand,
  validateProjectGitBranchName,
} from "./core.js";
import { hashContent, normalizePath, resolveProjectPath } from "./files.js";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Git does not know the worktree, and nothing names the branch it was on,
 * so there is nothing left to forget. Answered as 404 so the renderer can
 * tell "already gone" from a failed removal without reading the message.
 */
export class WorktreeNotFoundError extends RouteError {
  constructor() {
    super("Worktree was not found for this repository.", 404);
    this.name = "WorktreeNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const parseWorktreePorcelain = (output) => {
  const worktrees = [];
  let current = null;

  const pushCurrent = () => {
    if (current?.path) {
      worktrees.push({
        bare: current.bare === true,
        branch: current.branch ?? null,
        commit: current.commit ?? null,
        detached: current.detached === true,
        locked: current.locked === true,
        path: current.path,
        prunable: current.prunable === true,
      });
    }
    current = null;
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }

    if (line.startsWith("worktree ")) {
      pushCurrent();
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("HEAD ")) {
      current.commit = line.slice("HEAD ".length).trim() || null;
    } else if (line.startsWith("branch ")) {
      current.branch =
        line
          .slice("branch ".length)
          .trim()
          .replace(/^refs\/heads\//, "") || null;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }

  pushCurrent();
  return worktrees;
};

const isPathInsideDirectory = (targetPath, directoryPath) => {
  const relativePath = path.relative(
    path.resolve(directoryPath),
    path.resolve(targetPath),
  );
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
};

const getAppWorktreesDirectory = () =>
  path.join(os.homedir(), ".dream", "worktrees");

// Worktrees created before the move to ~/.dream/worktrees lived under the
// app's userData folder. Keep recognising them as app-managed.
const getLegacyAppWorktreesDirectory = () => {
  const hostDataDirectory = getHostDataDirectory();
  return hostDataDirectory ? path.join(hostDataDirectory, "worktrees") : null;
};

const isAppManagedWorktreePath = (worktreePath) => {
  const legacyDirectory = getLegacyAppWorktreesDirectory();
  return (
    isPathInsideDirectory(worktreePath, getAppWorktreesDirectory()) ||
    (legacyDirectory !== null &&
      isPathInsideDirectory(worktreePath, legacyDirectory))
  );
};

/**
 * App-managed worktrees live at `<worktrees>/<repo>-<hash>/<name>`. Once the
 * last worktree of a repository is removed, the `<repo>-<hash>` folder is left
 * empty; remove it. `rmdir` only deletes empty folders, so anything still in
 * it (another worktree, stray files) keeps it in place.
 */
export const removeEmptyAppWorktreeParent = async (worktreePath) => {
  const parentPath = path.dirname(path.resolve(worktreePath));
  // Only a direct child of a worktrees root. `path.relative` compares
  // case-insensitively on Windows, where git and Electron disagree on case.
  const isRepoFolder = [
    getAppWorktreesDirectory(),
    getLegacyAppWorktreesDirectory(),
  ]
    .filter((root) => root !== null)
    .some((root) => {
      const relativePath = path.relative(path.resolve(root), parentPath);
      return (
        relativePath !== "" &&
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath) &&
        !relativePath.includes(path.sep)
      );
    });
  if (!isRepoFolder) {
    return false;
  }

  try {
    await fs.rmdir(parentPath);
    return true;
  } catch {
    // Not empty, already gone, or still in use.
    return false;
  }
};

/** The repository's worktrees; shared like a status read. */
export const listProjectGitWorktrees = (projectPath) =>
  gitRepositories.share(`worktrees\0${path.resolve(projectPath)}`, () =>
    readProjectGitWorktrees(projectPath),
  );

const readProjectGitWorktrees = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    return {
      isRepo: false,
      mainWorktreePath: null,
      repoRoot: null,
      worktrees: [],
    };
  }

  const result = await runGitCommand(repoInfo.repoRoot, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const worktrees = parseWorktreePorcelain(result.stdout).map((worktree) => ({
    ...worktree,
    appManaged: isAppManagedWorktreePath(worktree.path),
  }));
  const mainWorktreePath =
    worktrees.find((worktree) => !worktree.bare)?.path ??
    worktrees[0]?.path ??
    repoInfo.repoRoot;

  return {
    isRepo: true,
    mainWorktreePath,
    repoRoot: repoInfo.repoRoot,
    worktrees,
  };
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const slugifyWorktreeBranch = (branchName) =>
  branchName
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "worktree";

const getDefaultWorktreePath = (repoRoot, mainWorktreePath, branchName) => {
  const worktreesDirectory = getAppWorktreesDirectory();
  const repoDirectoryName = `${path.basename(mainWorktreePath)}-${hashContent(
    path.resolve(repoRoot),
  ).slice(0, 10)}`;
  const projectName = path.basename(mainWorktreePath);
  return path.join(
    worktreesDirectory,
    repoDirectoryName,
    `${projectName}-${slugifyWorktreeBranch(branchName)}`,
  );
};

export const createProjectGitWorktree = async (
  projectPath,
  { baseRef = "", branchName = "" } = {},
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedBranchName = await validateProjectGitBranchName(
    repoInfo.repoRoot,
    branchName,
  );
  const branchExists = await gitRefExists(
    repoInfo.repoRoot,
    `refs/heads/${normalizedBranchName}`,
  );
  if (branchExists) {
    throw new Error(`Branch "${normalizedBranchName}" already exists.`);
  }

  const worktreesInfo = await listProjectGitWorktrees(projectPath);
  const mainWorktreePath = worktreesInfo.mainWorktreePath ?? repoInfo.repoRoot;
  const targetPath = path.resolve(
    getDefaultWorktreePath(
      repoInfo.repoRoot,
      mainWorktreePath,
      normalizedBranchName,
    ),
  );
  const normalizedBaseRef = baseRef?.trim() || repoInfo.branch || "HEAD";
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  await runGitCommand(repoInfo.repoRoot, [
    "worktree",
    "add",
    "-b",
    normalizedBranchName,
    targetPath,
    normalizedBaseRef,
  ]);

  return {
    baseRef: normalizedBaseRef,
    branch: normalizedBranchName,
    mainWorktreePath,
    path: targetPath,
    repoRoot: repoInfo.repoRoot,
  };
};

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

const mapNameStatusCode = (code) => {
  switch (code?.[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
};

export const parseGitNameStatusZ = (output) => {
  const tokens = (output ?? "").split("\0");
  const entries = [];

  for (let index = 0; index < tokens.length; index++) {
    const code = tokens[index];
    if (!code) {
      continue;
    }

    const status = mapNameStatusCode(code);
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index + 1] ?? "";
      const currentPath = tokens[index + 2] ?? "";
      index += 2;
      if (!currentPath) {
        continue;
      }
      entries.push({
        path: normalizePath(currentPath),
        previousPath: previousPath ? normalizePath(previousPath) : null,
        status,
      });
      continue;
    }

    const currentPath = tokens[index + 1] ?? "";
    index += 1;
    if (!currentPath) {
      continue;
    }
    entries.push({
      path: normalizePath(currentPath),
      previousPath: null,
      status,
    });
  }

  return entries;
};

const parseNumstatCount = (value) => {
  if (value === "-") {
    return 0;
  }
  return Number.parseInt(value, 10) || 0;
};

export const parseGitNumstatZ = (output) => {
  const tokens = (output ?? "").split("\0");
  const stats = new Map();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    const [added = "0", removed = "0", inlinePath = ""] = token.split("\t");
    const entry = {
      addedLines: parseNumstatCount(added),
      removedLines: parseNumstatCount(removed),
    };

    if (inlinePath) {
      stats.set(normalizePath(inlinePath), entry);
      continue;
    }

    // Rename/copy entries are emitted as "added\tremoved\t\0old\0new\0".
    const currentPath = tokens[index + 2] ?? "";
    index += 2;
    if (currentPath) {
      stats.set(normalizePath(currentPath), entry);
    }
  }

  return stats;
};

export const parseConflictingFiles = (output) =>
  (output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizePath);

export const isUsableBaseBranchCandidate = (baseRef, worktreeBranch = null) => {
  if (typeof baseRef !== "string") {
    return false;
  }

  const trimmed = baseRef.trim();
  if (!trimmed || trimmed === "HEAD" || /^HEAD\s/.test(trimmed)) {
    return false;
  }

  if (FULL_SHA_PATTERN.test(trimmed)) {
    return false;
  }

  const normalized = trimmed.replace(/^refs\/heads\//, "");
  if (worktreeBranch && normalized === worktreeBranch) {
    return false;
  }

  return true;
};

// ---------------------------------------------------------------------------
// Resolving a worktree
// ---------------------------------------------------------------------------

const isDetachedBranch = (branch) => !branch || branch.startsWith("HEAD ");

/**
 * The linked worktree at `projectPath`: its branch, its root and the main
 * checkout it belongs to. Compare, merge and diff all start here.
 */
const resolveWorktreeContext = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  if (isDetachedBranch(repoInfo.branch)) {
    throw new Error("Cannot complete a detached worktree.");
  }

  const worktreePath = path.resolve(projectPath);
  const worktreesInfo = await listProjectGitWorktrees(projectPath);
  const entry = worktreesInfo.worktrees.find(
    (worktree) => path.resolve(worktree.path) === worktreePath,
  );
  const mainWorktreePath = worktreesInfo.mainWorktreePath
    ? path.resolve(worktreesInfo.mainWorktreePath)
    : null;

  if (!entry || !mainWorktreePath || mainWorktreePath === worktreePath) {
    throw new Error("Project is not a linked worktree.");
  }

  return {
    mainWorktreePath,
    worktreeBranch: repoInfo.branch,
    worktreePath,
    worktreeRoot: repoInfo.repoRoot,
  };
};

const resolveWorktreeBaseBranch = async (
  mainWorktreePath,
  { baseRef = null, worktreeBranch = null } = {},
) => {
  const metadata = await getProjectGitMetadata(mainWorktreePath, null);
  const candidate = isUsableBaseBranchCandidate(baseRef, worktreeBranch)
    ? baseRef.trim().replace(/^refs\/heads\//, "")
    : metadata.baseBranch;

  if (!candidate) {
    throw new Error("Unable to determine the base branch for this worktree.");
  }

  const baseExistsLocally = await gitRefExists(
    mainWorktreePath,
    `refs/heads/${candidate}`,
  );
  const compareRef = baseExistsLocally
    ? candidate
    : await getPullRequestBaseRef(
        mainWorktreePath,
        metadata.remoteName,
        candidate,
      );

  if (!compareRef) {
    throw new Error(`Base branch "${candidate}" was not found.`);
  }

  return {
    baseBranch: candidate,
    baseExistsLocally,
    compareRef,
    remoteName: metadata.remoteName,
  };
};

const readMergeBase = async (cwd, compareRef) => {
  const result = await runGitCommand(cwd, ["merge-base", compareRef, "HEAD"], {
    allowFailure: true,
  });
  return result.ok ? result.stdout.trim() || null : null;
};

const readCurrentBranch = async (cwd) => {
  const result = await runGitCommand(cwd, ["branch", "--show-current"], {
    allowFailure: true,
  });
  return result.ok ? result.stdout.trim() || null : null;
};

const readTrackedDirtyCount = async (cwd) => {
  const result = await runGitCommand(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  return result.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
};

const hasGitRef = async (cwd, ref) => {
  const result = await runGitCommand(
    cwd,
    ["rev-parse", "-q", "--verify", ref],
    {
      allowFailure: true,
    },
  );
  return result.ok;
};

const hasInProgressOperation = async (cwd) =>
  (await hasGitRef(cwd, "MERGE_HEAD")) || (await hasGitRef(cwd, "REBASE_HEAD"));

const readCompareFiles = async (worktreeRoot, mergeBase) => {
  const [nameStatusResult, numstatResult] = await Promise.all([
    runGitCommand(worktreeRoot, [
      "diff",
      "--name-status",
      "--find-renames",
      "--no-ext-diff",
      "-z",
      mergeBase,
      "HEAD",
    ]),
    runGitCommand(worktreeRoot, [
      "diff",
      "--numstat",
      "--find-renames",
      "--no-ext-diff",
      "-z",
      mergeBase,
      "HEAD",
    ]),
  ]);
  const stats = parseGitNumstatZ(numstatResult.stdout);

  return parseGitNameStatusZ(nameStatusResult.stdout)
    .map((entry) => {
      const entryStats = stats.get(entry.path) ?? {
        addedLines: 0,
        removedLines: 0,
      };
      return {
        ...entry,
        addedLines: entryStats.addedLines,
        removedLines: entryStats.removedLines,
        staged: false,
        unstaged: false,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

/**
 * The pull request GitHub has for `branch`, newest first, or `null` when
 * there is none or `gh` cannot say (not logged in, no GitHub remote, ...).
 */
const readBranchPullRequest = async (cwd, branch, base = null) => {
  const result = await runGhCommand(
    cwd,
    [
      "pr",
      "list",
      "--head",
      branch,
      ...(base ? ["--base", base] : []),
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,url,state,isDraft,mergedAt",
    ],
    { allowFailure: true },
  );
  if (!result.ok) {
    return null;
  }
  try {
    const [entry] = JSON.parse(result.stdout);
    if (!entry || typeof entry.number !== "number") {
      return null;
    }
    const state = String(entry.state ?? "").toLowerCase();
    return {
      isDraft: entry.isDraft === true,
      mergedAt: typeof entry.mergedAt === "string" ? entry.mergedAt : null,
      number: entry.number,
      state:
        state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      url: typeof entry.url === "string" ? entry.url : "",
    };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export const compareProjectGitWorktree = async (
  projectPath,
  { baseRef = null } = {},
) => {
  const context = await resolveWorktreeContext(projectPath);
  const base = await resolveWorktreeBaseBranch(context.mainWorktreePath, {
    baseRef,
    worktreeBranch: context.worktreeBranch,
  });
  const rangeRef = `${base.compareRef}..HEAD`;

  const [
    mergeBase,
    counts,
    commits,
    totalCommits,
    worktreeStatus,
    worktreeMetadata,
    mainBranch,
    mainDirtyCount,
    mainInProgressOperation,
    ghResult,
  ] = await Promise.all([
    readMergeBase(context.worktreeRoot, base.compareRef),
    getGitAheadBehindCounts(context.worktreeRoot, base.compareRef),
    readGitPushPreviewCommits(context.worktreeRoot, rangeRef),
    readGitCommitCount(context.worktreeRoot, rangeRef),
    listProjectGitChanges(projectPath),
    getProjectGitMetadata(context.worktreeRoot, context.worktreeBranch),
    readCurrentBranch(context.mainWorktreePath),
    readTrackedDirtyCount(context.mainWorktreePath),
    hasInProgressOperation(context.mainWorktreePath),
    runGhCommand(context.mainWorktreePath, ["--version"], {
      allowFailure: true,
    }),
  ]);
  const [files, pullRequest] = await Promise.all([
    mergeBase ? readCompareFiles(context.worktreeRoot, mergeBase) : [],
    ghResult.ok && base.remoteName
      ? readBranchPullRequest(context.mainWorktreePath, context.worktreeBranch)
      : null,
  ]);

  return {
    aheadCount: counts.aheadCount,
    baseBranch: base.baseBranch,
    baseExistsLocally: base.baseExistsLocally,
    behindCount: counts.behindCount,
    branch: context.worktreeBranch,
    commits,
    compareRef: base.compareRef,
    files,
    ghAvailable: ghResult.ok,
    mainBranch,
    mainClean: mainDirtyCount === 0,
    mainDirtyCount,
    mainInProgressOperation,
    mainWorktreePath: context.mainWorktreePath,
    mergeBase,
    pullRequest,
    remoteName: base.remoteName,
    totalCommits,
    truncated: commits.length < totalCommits,
    upstreamBranch: worktreeMetadata.upstreamBranch,
    worktreePath: context.worktreePath,
    worktreeStatus,
  };
};

export const getProjectGitWorktreeCompareDiff = async (
  projectPath,
  { baseRef = null, filePath, previousPath = null, status },
) => {
  const context = await resolveWorktreeContext(projectPath);
  const base = await resolveWorktreeBaseBranch(context.mainWorktreePath, {
    baseRef,
    worktreeBranch: context.worktreeBranch,
  });
  const mergeBase = await readMergeBase(context.worktreeRoot, base.compareRef);
  if (!mergeBase) {
    throw new Error("No common ancestor with the base branch.");
  }

  const normalizedFilePath = normalizePath(filePath);
  const toRepoRelative = (value) =>
    normalizePath(
      path.relative(
        context.worktreeRoot,
        resolveProjectPath(projectPath, normalizePath(value)),
      ),
    );
  const pathspec = [toRepoRelative(normalizedFilePath)];
  if (previousPath) {
    pathspec.push(toRepoRelative(previousPath));
  }

  const diffResult = await runGitCommand(context.worktreeRoot, [
    "diff",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    mergeBase,
    "HEAD",
    "--",
    ...pathspec,
  ]);

  return {
    branch: context.worktreeBranch,
    diff: diffResult.stdout,
    filePath: normalizedFilePath,
    parsedDiff: parseSingleFileDiff(diffResult.stdout),
    previousPath,
    status,
  };
};

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export const mergeProjectGitWorktree = async (
  projectPath,
  { acknowledgeUncommitted = false, baseRef = null } = {},
) => {
  const context = await resolveWorktreeContext(projectPath);
  const base = await resolveWorktreeBaseBranch(context.mainWorktreePath, {
    baseRef,
    worktreeBranch: context.worktreeBranch,
  });

  if (
    !acknowledgeUncommitted &&
    (await readTrackedDirtyCount(context.worktreeRoot)) > 0
  ) {
    throw new Error(
      "The worktree has uncommitted changes. Commit them or choose to discard them first.",
    );
  }

  if (await hasInProgressOperation(context.mainWorktreePath)) {
    throw new Error("The main worktree has a merge or rebase in progress.");
  }

  const previousMainBranch = await readCurrentBranch(context.mainWorktreePath);
  if ((await readTrackedDirtyCount(context.mainWorktreePath)) > 0) {
    throw new Error(
      `The main worktree has uncommitted changes on ${
        previousMainBranch ?? "its current branch"
      }. Commit or stash them before merging.`,
    );
  }

  const counts = await getGitAheadBehindCounts(
    context.worktreeRoot,
    base.compareRef,
  );
  if (counts.aheadCount === 0) {
    throw new Error(
      `${context.worktreeBranch} has no commits to merge into ${base.baseBranch}.`,
    );
  }

  if (previousMainBranch !== base.baseBranch) {
    await runGitCommand(context.mainWorktreePath, [
      "checkout",
      base.baseBranch,
    ]);
  }

  const branchHeadResult = await runGitCommand(context.mainWorktreePath, [
    "rev-parse",
    `refs/heads/${context.worktreeBranch}`,
  ]);
  const branchHead = branchHeadResult.stdout.trim();

  const mergeResult = await runGitCommand(
    context.mainWorktreePath,
    ["merge", "--no-edit", context.worktreeBranch],
    { allowFailure: true },
  );

  if (!mergeResult.ok) {
    if (await hasGitRef(context.mainWorktreePath, "MERGE_HEAD")) {
      const conflictsResult = await runGitCommand(
        context.mainWorktreePath,
        ["diff", "--name-only", "--diff-filter=U"],
        { allowFailure: true },
      );
      await runGitCommand(context.mainWorktreePath, ["merge", "--abort"], {
        allowFailure: true,
      });

      return {
        baseBranch: base.baseBranch,
        branch: context.worktreeBranch,
        conflictingFiles: parseConflictingFiles(conflictsResult.stdout),
        mainWorktreePath: context.mainWorktreePath,
        previousMainBranch,
        status: "conflict",
      };
    }

    throw new Error(getGitCommandErrorMessage(mergeResult.error));
  }

  const afterHeadResult = await runGitCommand(context.mainWorktreePath, [
    "rev-parse",
    "HEAD",
  ]);
  const mergeCommit = afterHeadResult.stdout.trim();

  return {
    baseBranch: base.baseBranch,
    branch: context.worktreeBranch,
    fastForward: mergeCommit === branchHead,
    mainWorktreePath: context.mainWorktreePath,
    mergeCommit,
    previousMainBranch,
    status: "merged",
  };
};

// ---------------------------------------------------------------------------
// Forget
// ---------------------------------------------------------------------------

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const WORKTREE_DELETE_FAILURE_PATTERN =
  /failed to delete|permission denied|access is denied|directory not empty|device or resource busy|being used by another process/i;

const isWorktreeDeleteFailure = (message) =>
  WORKTREE_DELETE_FAILURE_PATTERN.test(message);

/**
 * On Windows a directory cannot be deleted while any process holds a handle
 * inside it. Release what Dream's own agents hold, then delete with retries
 * to ride out handles that are still closing (exited CLIs, antivirus, the
 * search indexer).
 */
const deleteLockedWorktreeDirectory = async (targetPath, gitMessage) => {
  await releaseProjectDirectory(targetPath);

  try {
    await fs.rm(targetPath, {
      force: true,
      maxRetries: 8,
      recursive: true,
      retryDelay: 250,
    });
  } catch {
    throw new Error(
      `${gitMessage}
Another program is still using this folder. Close any terminal, editor, or file explorer window open inside it and retry.`,
    );
  }
};

/**
 * Removes a worktree git still lists. Returns whether git's registration had
 * to be pruned by hand because `worktree remove` could not finish.
 */
const removeRegisteredWorktree = async (commandCwd, targetPath, force) => {
  const removeResult = await runGitCommand(
    commandCwd,
    ["worktree", "remove", ...(force ? ["--force"] : []), targetPath],
    { allowFailure: true },
  );
  if (removeResult.ok) {
    return false;
  }

  if (await pathExists(targetPath)) {
    const message = getGitCommandErrorMessage(removeResult.error);
    // Git only reaches the delete stage after its own safety checks pass, so
    // finishing the deletion ourselves cannot discard work it would refuse to.
    if (!isWorktreeDeleteFailure(message)) {
      throw new Error(message);
    }
    await deleteLockedWorktreeDirectory(targetPath, message);
  }

  await runGitCommand(commandCwd, ["worktree", "prune"]);
  return true;
};

/**
 * Tidies after a worktree git no longer lists (removed by hand, or its
 * registration pruned). An empty leftover folder is removed; one with files
 * in it is not ours to delete, since git is not vouching for what they are.
 */
const pruneForgottenWorktree = async (commandCwd, targetPath) => {
  await runGitCommand(commandCwd, ["worktree", "prune"]);
  try {
    await fs.rmdir(targetPath);
  } catch {
    // Not empty, or already gone.
  }
  return true;
};

const deleteMergedBranch = async (commandCwd, branch) => {
  // `-d`, never `-D`: git refuses when the branch holds unmerged work.
  const result = await runGitCommand(commandCwd, ["branch", "-d", branch], {
    allowFailure: true,
  });
  return {
    branchDeleted: result.ok,
    branchDeleteError: result.ok
      ? null
      : getGitCommandErrorMessage(result.error),
  };
};

/**
 * Forgets a worktree: removes its checkout, deletes its branch when asked
 * and the branch is merged, and drops what Dream kept for the directory.
 *
 * `branch` is the worktree's branch as the app recorded it. It lets the
 * branch still be deleted when git has already forgotten the worktree; with
 * neither, there is nothing to go on and the answer is
 * `WorktreeNotFoundError`.
 */
export const forgetProjectGitWorktree = async (
  projectPath,
  {
    branch: knownBranch = null,
    deleteBranch = false,
    force = false,
    worktreePath = "",
  } = {},
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const targetPath = path.resolve(worktreePath);
  const worktreesInfo = await listProjectGitWorktrees(projectPath);
  const commandCwd = worktreesInfo.mainWorktreePath ?? repoInfo.repoRoot;
  if (path.resolve(commandCwd) === targetPath) {
    throw new Error("Cannot remove the main worktree.");
  }

  const entry =
    worktreesInfo.worktrees.find(
      (worktree) => path.resolve(worktree.path) === targetPath,
    ) ?? null;
  if (!entry && !knownBranch) {
    // Still gone as far as the app is concerned: drop what Dream kept for it.
    await forgetProjectDirectory(targetPath);
    throw new WorktreeNotFoundError();
  }

  const pruned = entry
    ? await removeRegisteredWorktree(commandCwd, targetPath, force)
    : await pruneForgottenWorktree(commandCwd, targetPath);
  await removeEmptyAppWorktreeParent(targetPath);
  await forgetProjectDirectory(targetPath);

  const branch = entry?.branch ?? knownBranch;
  const branchExists = branch
    ? await hasGitRef(commandCwd, `refs/heads/${branch}`)
    : false;
  const deletion =
    deleteBranch && branchExists
      ? await deleteMergedBranch(commandCwd, branch)
      : { branchDeleted: false, branchDeleteError: null };

  return {
    branch: branchExists ? branch : null,
    ...deletion,
    path: targetPath,
    pruned,
    removed: true,
  };
};
