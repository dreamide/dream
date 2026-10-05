import { promises as fs } from "node:fs";
import path from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { execFileAsync } from "../shared/cli.js";
import { hashContent, normalizePath, resolveProjectPath } from "./files.js";
import {
  createGitRepositoryContext,
  getGitCommandErrorMessage,
} from "./repository-context.js";

export { getGitCommandErrorMessage };

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const GH_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

/** Starts one git process: the context's runner (repository-context.js). */
const execGitCommand = async (cwd, args, { allowFailure = false } = {}) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      ok: true,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (allowFailure) {
      return {
        error,
        ok: false,
        stderr: typeof error?.stderr === "string" ? error.stderr : "",
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
      };
    }

    throw new Error(getGitCommandErrorMessage(error));
  }
};

/** The host's Git repositories: remembered facts and shared reads. */
export const gitRepositories = createGitRepositoryContext({
  run: execGitCommand,
});

/**
 * Runs one git command. A command that may write makes the host forget
 * what it remembered about every repository (repository-context.js).
 */
export const runGitCommand = (cwd, args, options) =>
  gitRepositories.run(cwd, args, options);

const getGhCommandErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "GitHub CLI is not available on PATH.";
  }

  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";

  return stderr || stdout || "GitHub CLI command failed.";
};

export const runGhCommand = async (
  cwd,
  args,
  { allowFailure = false } = {},
) => {
  try {
    const result = await execFileAsync("gh", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GH_EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      ok: true,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (allowFailure) {
      return {
        error,
        ok: false,
        stderr: typeof error?.stderr === "string" ? error.stderr : "",
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
      };
    }

    throw new Error(getGhCommandErrorMessage(error));
  }
};

const isChangedGitStatusCode = (value) =>
  typeof value === "string" && value !== "" && value !== "." && value !== " ";

const mapGitChangeState = (xy, untracked = false) => {
  if (untracked) {
    return {
      staged: false,
      unstaged: true,
    };
  }

  const x = xy?.[0] ?? ".";
  const y = xy?.[1] ?? ".";

  return {
    staged: isChangedGitStatusCode(x),
    unstaged: isChangedGitStatusCode(y),
  };
};

const getPreferredGitRemote = (repoRoot) =>
  gitRepositories.remoteName(repoRoot);

export const gitRefExists = async (repoRoot, ref) => {
  const result = await runGitCommand(
    repoRoot,
    ["show-ref", "--verify", "--quiet", ref],
    { allowFailure: true },
  );

  return result.ok;
};

const getGitDefaultBranch = (repoRoot, remoteName) =>
  gitRepositories.defaultBranch(repoRoot, remoteName);

/**
 * The upstream of the checked-out branch, or of `branch` when given, as
 * `remote/branch`.
 */
export const getCurrentGitUpstream = async (repoRoot, branch = null) => {
  const upstreamResult = await runGitCommand(
    repoRoot,
    [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      branch ? `refs/heads/${branch}@{u}` : "@{u}",
    ],
    { allowFailure: true },
  );

  return upstreamResult.ok ? upstreamResult.stdout.trim() || null : null;
};

const readGitConfigValue = async (repoRoot, key) => {
  const result = await runGitCommand(repoRoot, ["config", "--get", key], {
    allowFailure: true,
  });
  return result.ok ? result.stdout.trim() : "";
};

/**
 * The remote branch `branch` tracks, as the remote name and the local
 * remote-tracking ref. `null` when the branch tracks nothing, e.g. a
 * repository with no remote.
 */
export const resolveGitBranchUpstream = async (repoRoot, branch) => {
  const remote = await readGitConfigValue(repoRoot, `branch.${branch}.remote`);
  const mergeRef = await readGitConfigValue(repoRoot, `branch.${branch}.merge`);
  if (!remote || remote === "." || !mergeRef.startsWith("refs/heads/")) {
    return null;
  }

  const remoteBranch = mergeRef.slice("refs/heads/".length);
  return {
    ref: `refs/remotes/${remote}/${remoteBranch}`,
    remote,
    remoteBranch,
    upstream: `${remote}/${remoteBranch}`,
  };
};

export const getGitAheadBehindCounts = async (
  repoRoot,
  upstreamBranch,
  headRef = "HEAD",
) => {
  if (!upstreamBranch) {
    return {
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const countsResult = await runGitCommand(
    repoRoot,
    ["rev-list", "--left-right", "--count", `${upstreamBranch}...${headRef}`],
    { allowFailure: true },
  );

  if (!countsResult.ok) {
    return {
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const [behind = "0", ahead = "0"] = countsResult.stdout.trim().split(/\s+/);
  return {
    aheadCount: Number.parseInt(ahead, 10) || 0,
    behindCount: Number.parseInt(behind, 10) || 0,
  };
};

/**
 * Remote, upstream and ahead/behind counts for the checked-out branch, or,
 * with `named`, for `branch` itself whether or not it is checked out.
 * `tracking` is the checked-out branch's upstream and counts when the
 * caller already has them (`git status --branch` reports both).
 */
export const getProjectGitMetadata = async (
  repoRoot,
  branch,
  { named = false, tracking = null } = {},
) => {
  const remoteName = await getPreferredGitRemote(repoRoot);
  const [baseBranch, upstreamBranch] = await Promise.all([
    getGitDefaultBranch(repoRoot, remoteName),
    tracking
      ? tracking.upstreamBranch
      : branch?.startsWith("HEAD ")
        ? Promise.resolve(null)
        : getCurrentGitUpstream(repoRoot, named ? branch : null),
  ]);
  const { aheadCount, behindCount } =
    tracking ??
    (await getGitAheadBehindCounts(
      repoRoot,
      upstreamBranch,
      named ? `refs/heads/${branch}` : "HEAD",
    ));

  return {
    aheadCount,
    baseBranch,
    behindCount,
    remoteName,
    upstreamBranch,
  };
};

const summarizeProjectGitChanges = (changes) => {
  const summary = changes.reduce(
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

  return summary;
};

const isBinaryBuffer = (buffer) => {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
};

const toProjectRelativeGitPath = (projectPath, repoRoot, gitPath) => {
  const absolutePath = path.resolve(repoRoot, gitPath);
  const projectRoot = path.resolve(projectPath);
  const relativePath = path.relative(projectRoot, absolutePath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return normalizePath(relativePath);
};

/** The repository's top folder, or null when the project is in none. */
const getGitRepositoryRoot = (projectPath) =>
  gitRepositories.repositoryRoot(projectPath);

/** A detached HEAD's name, `HEAD <short revision>`, or null. */
const getDetachedHeadName = async (repoRoot) => {
  const detachedHeadResult = await runGitCommand(
    repoRoot,
    ["rev-parse", "--short", "HEAD"],
    { allowFailure: true },
  );
  const revision = detachedHeadResult.ok
    ? detachedHeadResult.stdout.trim()
    : "";
  return revision ? `HEAD ${revision}` : null;
};

export const getGitRepositoryInfo = async (projectPath) => {
  const repoRoot = await getGitRepositoryRoot(projectPath);
  if (!repoRoot) {
    return {
      branch: null,
      isRepo: false,
      repoRoot: null,
    };
  }

  const branchResult = await runGitCommand(
    repoRoot,
    ["branch", "--show-current"],
    { allowFailure: true },
  );
  const branch = branchResult.ok ? branchResult.stdout.trim() : "";

  return {
    branch: branch || (await getDetachedHeadName(repoRoot)),
    isRepo: true,
    repoRoot,
  };
};

const mapGitChangeStatus = (xy, fallbackCode = "") => {
  const codes = [fallbackCode, ...(xy ?? "")]
    .map((value) => value.trim())
    .filter((value) => value && value !== ".");

  if (codes.includes("R")) {
    return "renamed";
  }

  if (codes.includes("C")) {
    return "copied";
  }

  if (codes.includes("A")) {
    return "added";
  }

  if (codes.includes("D")) {
    return "deleted";
  }

  return "modified";
};

/**
 * The `# branch.*` lines of `git status --porcelain=v2 --branch`: the branch
 * (or that HEAD is detached), HEAD's commit (null before the first commit),
 * and, when git counted them, the upstream with ahead/behind counts.
 */
export const parseGitStatusBranchHeaders = (entries) => {
  const headers = new Map();
  for (const entry of entries) {
    if (!entry.startsWith("# branch.")) continue;
    const separator = entry.indexOf(" ", 2);
    if (separator === -1) continue;
    headers.set(entry.slice(2, separator), entry.slice(separator + 1));
  }

  const branchHead = headers.get("branch.head") ?? "";
  const oid = headers.get("branch.oid") ?? "";
  const upstreamBranch = headers.get("branch.upstream") || null;
  const counts = /^\+(\d+) -(\d+)$/.exec(headers.get("branch.ab") ?? "");
  return {
    branch: branchHead === "(detached)" ? "" : branchHead,
    detached: branchHead === "(detached)",
    oid: /^[0-9a-f]{4,}$/i.test(oid) ? oid : null,
    tracking:
      upstreamBranch && counts
        ? {
            aheadCount: Number.parseInt(counts[1], 10),
            behindCount: Number.parseInt(counts[2], 10),
            upstreamBranch,
          }
        : null,
  };
};

const FULL_STATUS = {
  includeMetadata: true,
  includeStats: true,
  includeUntracked: true,
};

const statusReadKey = (projectPath, options) =>
  `status\0${path.resolve(projectPath)}\0${[
    options.includeMetadata,
    options.includeStats,
    options.includeUntracked,
  ]
    .map(Number)
    .join("")}`;

/** `status` as a read with less detail would have reported it. */
const narrowProjectGitStatus = (status, options) => {
  if (!status.isRepo) return status;
  const changes = status.changes
    .filter(
      (change) => options.includeUntracked || change.status !== "untracked",
    )
    .map((change) =>
      options.includeStats
        ? change
        : { ...change, addedLines: 0, removedLines: 0 },
    );
  return {
    ...status,
    ...(options.includeMetadata
      ? {}
      : {
          aheadCount: 0,
          baseBranch: null,
          behindCount: 0,
          remoteName: null,
          upstreamBranch: null,
        }),
    changes,
    ...summarizeProjectGitChanges(changes),
  };
};

/**
 * The project's changes, branch and (in full) line counts and upstream. A
 * read made while an identical one has just started shares it, and a less
 * detailed read is answered from a full one (repository-context.js).
 */
export const listProjectGitChanges = (projectPath, options = {}) => {
  const detail = { ...FULL_STATUS, ...options };
  const isFull =
    detail.includeMetadata && detail.includeStats && detail.includeUntracked;
  if (!isFull) {
    const fullRead = gitRepositories.joinable(
      statusReadKey(projectPath, FULL_STATUS),
    );
    if (fullRead) {
      return fullRead.then((status) => narrowProjectGitStatus(status, detail));
    }
  }
  return gitRepositories.share(statusReadKey(projectPath, detail), () =>
    readProjectGitChanges(projectPath, detail),
  );
};

const readProjectGitChanges = async (
  projectPath,
  { includeMetadata, includeStats, includeUntracked },
) => {
  const repoRoot = await getGitRepositoryRoot(projectPath);
  if (!repoRoot) {
    return {
      addedLines: 0,
      aheadCount: 0,
      baseBranch: null,
      branch: null,
      changes: [],
      behindCount: 0,
      fileCount: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      isRepo: false,
      remoteName: null,
      removedLines: 0,
      repoRoot: null,
      stagedCount: 0,
      unstagedCount: 0,
      upstreamBranch: null,
    };
  }

  // `--branch` reports the branch, HEAD and the upstream counts in this one
  // call, in place of a git process for each.
  const statusResult = await runGitCommand(repoRoot, [
    "status",
    "--porcelain=v2",
    "--branch",
    ...(includeMetadata ? [] : ["--no-ahead-behind"]),
    "-z",
    includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
  ]);
  const entries = statusResult.stdout.split("\0").filter(Boolean);
  const head = parseGitStatusBranchHeaders(entries);
  const repoInfo = {
    branch: head.detached
      ? await getDetachedHeadName(repoRoot)
      : head.branch || null,
    repoRoot,
  };
  const changes = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (entry.startsWith("? ")) {
      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        entry.slice(2),
      );

      if (!projectRelativePath) {
        continue;
      }

      changes.push({
        ...mapGitChangeState("", true),
        path: projectRelativePath,
        previousPath: null,
        status: "untracked",
      });
      continue;
    }

    if (entry.startsWith("1 ")) {
      const fields = entry.split(" ");
      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        fields.slice(8).join(" "),
      );

      if (!projectRelativePath) {
        continue;
      }

      changes.push({
        ...mapGitChangeState(fields[1] ?? ""),
        path: projectRelativePath,
        previousPath: null,
        status: mapGitChangeStatus(fields[1] ?? ""),
      });
      continue;
    }

    if (entry.startsWith("2 ")) {
      const fields = entry.split(" ");
      const currentPath = fields.slice(9).join(" ");
      const previousPath = entries[index + 1] ?? "";
      index += 1;

      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        currentPath,
      );

      if (!projectRelativePath) {
        continue;
      }

      const previousProjectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        previousPath,
      );

      changes.push({
        ...mapGitChangeState(fields[1] ?? ""),
        path: projectRelativePath,
        previousPath: previousProjectRelativePath,
        status: mapGitChangeStatus(fields[1] ?? "", fields[8]?.[0] ?? ""),
      });
    }
  }

  changes.sort((left, right) => left.path.localeCompare(right.path));
  // Line counts and the remote are independent: read them together.
  const [statsByPath, metadata] = await Promise.all([
    includeStats
      ? getProjectGitChangeStats(projectPath, repoRoot, changes, {
          baseRef: head.oid ?? EMPTY_GIT_TREE_HASH,
        })
      : new Map(),
    includeMetadata
      ? getProjectGitMetadata(repoRoot, repoInfo.branch, {
          tracking: head.tracking,
        })
      : {
          aheadCount: 0,
          baseBranch: null,
          behindCount: 0,
          remoteName: null,
          upstreamBranch: null,
        },
  ]);

  const enrichedChanges = changes.map((change) => {
    const stats = statsByPath.get(change.path) ?? {
      addedLines: 0,
      removedLines: 0,
    };

    return {
      ...change,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    };
  });
  return {
    ...metadata,
    branch: repoInfo.branch,
    changes: enrichedChanges,
    isRepo: true,
    repoRoot: repoInfo.repoRoot,
    ...summarizeProjectGitChanges(enrichedChanges),
  };
};

/** The project's local branches, current first; shared like a status read. */
export const listProjectGitBranches = (projectPath) =>
  gitRepositories.share(`branches\0${path.resolve(projectPath)}`, () =>
    readProjectGitBranches(projectPath),
  );

const readProjectGitBranches = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    return {
      branches: [],
      currentBranch: repoInfo.branch,
      isRepo: false,
      repoRoot: null,
    };
  }

  const branchResult = await runGitCommand(repoInfo.repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const currentBranch = repoInfo.branch;
  const branchNames = branchResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => {
      if (left === currentBranch) {
        return -1;
      }

      if (right === currentBranch) {
        return 1;
      }

      return left.localeCompare(right);
    });

  return {
    branches: branchNames.map((name) => ({
      current: name === currentBranch,
      name,
    })),
    currentBranch,
    isRepo: true,
    repoRoot: repoInfo.repoRoot,
  };
};

export const validateProjectGitBranchName = async (repoRoot, branchName) => {
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error("Branch name is required.");
  }

  const validationResult = await runGitCommand(
    repoRoot,
    ["check-ref-format", "--branch", normalizedBranchName],
    { allowFailure: true },
  );
  if (!validationResult.ok) {
    throw new Error(
      validationResult.stderr.trim() ||
        validationResult.stdout.trim() ||
        "Invalid Git branch name.",
    );
  }

  return normalizedBranchName;
};

export const checkoutProjectGitBranch = async (
  projectPath,
  branchName,
  create,
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedBranchName = await validateProjectGitBranchName(
    repoInfo.repoRoot,
    branchName,
  );
  const branchesInfo = await listProjectGitBranches(projectPath);
  const branchExists = branchesInfo.branches.some(
    (entry) => entry.name === normalizedBranchName,
  );

  if (create && branchExists) {
    throw new Error(`Branch "${normalizedBranchName}" already exists.`);
  }

  if (!create && !branchExists) {
    throw new Error(`Branch "${normalizedBranchName}" does not exist.`);
  }

  await runGitCommand(
    repoInfo.repoRoot,
    create
      ? ["checkout", "-b", normalizedBranchName]
      : ["checkout", normalizedBranchName],
  );

  return {
    ...(await listProjectGitBranches(projectPath)),
    created: create,
  };
};

const getGitDiffBaseRef = async (repoRoot) => {
  const headResult = await runGitCommand(
    repoRoot,
    ["rev-parse", "--verify", "HEAD"],
    { allowFailure: true },
  );
  return headResult.ok ? headResult.stdout.trim() : EMPTY_GIT_TREE_HASH;
};

const countUntrackedFileLines = async (projectPath, filePath) => {
  const absolutePath = resolveProjectPath(projectPath, filePath);
  const contents = await fs.readFile(absolutePath);

  if (isBinaryBuffer(contents)) {
    return { addedLines: 0, removedLines: 0 };
  }

  const text = contents.toString("utf8");
  if (!text) {
    return { addedLines: 0, removedLines: 0 };
  }

  const lines = text.split(/\r?\n/);
  return {
    addedLines: text.endsWith("\n") ? lines.length - 1 : lines.length,
    removedLines: 0,
  };
};

const parseNumstatValue = (value) => {
  return value === "-" ? 0 : Number.parseInt(value, 10) || 0;
};

const getProjectGitChangeStats = async (
  projectPath,
  repoRoot,
  changes,
  { baseRef: knownBaseRef = null } = {},
) => {
  const statsByPath = new Map();
  const trackedPaths = changes
    .filter((change) => change.status !== "untracked")
    .map((change) =>
      normalizePath(
        path.relative(repoRoot, resolveProjectPath(projectPath, change.path)),
      ),
    );

  if (trackedPaths.length > 0) {
    const baseRef = knownBaseRef ?? (await getGitDiffBaseRef(repoRoot));
    const diffResult = await runGitCommand(repoRoot, [
      "diff",
      "--numstat",
      "--find-renames",
      "--no-ext-diff",
      "--submodule=diff",
      baseRef,
      "--",
      ...trackedPaths,
    ]);

    for (const line of diffResult.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const [added = "0", removed = "0", ...pathParts] = trimmed.split("\t");
      const repoRelativePath = pathParts.join("\t").trim();
      if (!repoRelativePath) {
        continue;
      }

      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoRoot,
        repoRelativePath,
      );
      if (!projectRelativePath) {
        continue;
      }

      statsByPath.set(projectRelativePath, {
        addedLines: parseNumstatValue(added),
        removedLines: parseNumstatValue(removed),
      });
    }
  }

  for (const change of changes) {
    if (statsByPath.has(change.path)) {
      continue;
    }

    if (change.status === "untracked") {
      statsByPath.set(
        change.path,
        await countUntrackedFileLines(projectPath, change.path),
      );
      continue;
    }

    statsByPath.set(change.path, { addedLines: 0, removedLines: 0 });
  }

  return statsByPath;
};

const buildUntrackedFileDiff = async (projectPath, filePath) => {
  const absolutePath = resolveProjectPath(projectPath, filePath);
  const contents = await fs.readFile(absolutePath);

  if (isBinaryBuffer(contents)) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      `Binary files /dev/null and b/${filePath} differ`,
    ].join("\n");
  }

  const text = contents.toString("utf8");
  if (!text) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${filePath}`,
    ].join("\n");
  }

  const lines = text.split(/\r?\n/);
  const endsWithNewline = text.endsWith("\n");
  const payloadLines = endsWithNewline ? lines.slice(0, -1) : lines;

  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${payloadLines.length} @@`,
    ...payloadLines.map((line) => `+${line}`),
    ...(endsWithNewline ? [] : ["\\ No newline at end of file"]),
  ].join("\n");
};

export const parseSingleFileDiff = (patch) => {
  if (typeof patch !== "string" || patch.trim().length === 0) {
    return null;
  }

  try {
    const parsedPatches = parsePatchFiles(patch);
    if (parsedPatches.length !== 1) {
      return null;
    }

    const files = parsedPatches[0]?.files;
    if (!Array.isArray(files) || files.length !== 1) {
      return null;
    }

    return files[0] ?? null;
  } catch {
    return null;
  }
};

export const getProjectGitDiff = async (
  projectPath,
  filePath,
  { previousPath = null, status },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);

  if (status === "untracked") {
    const diff = await buildUntrackedFileDiff(projectPath, normalizedFilePath);
    return {
      branch: repoInfo.branch,
      diff,
      filePath: normalizedFilePath,
      parsedDiff: parseSingleFileDiff(diff),
      previousPath,
      status,
    };
  }

  const repoRelativePath = normalizePath(
    path.relative(
      repoInfo.repoRoot,
      resolveProjectPath(projectPath, normalizedFilePath),
    ),
  );
  const baseRef = await getGitDiffBaseRef(repoInfo.repoRoot);
  const diffResult = await runGitCommand(repoInfo.repoRoot, [
    "diff",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    baseRef,
    "--",
    repoRelativePath,
  ]);

  return {
    branch: repoInfo.branch,
    diff: diffResult.stdout,
    filePath: normalizedFilePath,
    parsedDiff: parseSingleFileDiff(diffResult.stdout),
    previousPath,
    status,
  };
};

export const getProjectGitFileAtHead = async (projectPath, filePath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);
  const repoRelativePath = normalizePath(
    path.relative(
      repoInfo.repoRoot,
      resolveProjectPath(projectPath, normalizedFilePath),
    ),
  );
  const baseRef = await getGitDiffBaseRef(repoInfo.repoRoot);
  if (baseRef === EMPTY_GIT_TREE_HASH) {
    throw new Error("The file does not exist in Git history.");
  }

  try {
    const result = await execFileAsync(
      "git",
      ["cat-file", "blob", `${baseRef}:${repoRelativePath}`],
      {
        cwd: repoInfo.repoRoot,
        encoding: null,
        maxBuffer: GIT_EXEC_MAX_BUFFER,
        windowsHide: true,
      },
    );

    return {
      data: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout),
      filePath: normalizedFilePath,
    };
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : typeof error?.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(stderr || "Unable to read the file from Git history.");
  }
};

export const revertProjectGitFile = async (
  projectPath,
  filePath,
  { previousPath = null, status },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);
  const absolutePath = resolveProjectPath(projectPath, normalizedFilePath);

  if (status === "untracked") {
    await fs.rm(absolutePath, { force: true, recursive: false });
    return { filePath: normalizedFilePath, reverted: true };
  }

  const repoRelativePaths = [normalizedFilePath, previousPath]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) =>
      normalizePath(
        path.relative(
          repoInfo.repoRoot,
          resolveProjectPath(projectPath, value),
        ),
      ),
    );
  const uniqueRepoRelativePaths = [...new Set(repoRelativePaths)];
  if (uniqueRepoRelativePaths.length === 0) {
    throw new Error("No file path was provided.");
  }

  await runGitCommand(repoInfo.repoRoot, [
    "restore",
    "--staged",
    "--worktree",
    "--source=HEAD",
    "--",
    ...uniqueRepoRelativePaths,
  ]);

  return { filePath: normalizedFilePath, reverted: true };
};

// Reverts every change under the project directory in one pass instead of one
// request per file. The pathspec is "." with cwd set to the project, so when the
// project is a subdirectory of a larger repo, nothing outside it is touched.
export const revertAllProjectGitChanges = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const baseRef = await getGitDiffBaseRef(repoInfo.repoRoot);
  if (baseRef === EMPTY_GIT_TREE_HASH) {
    throw new Error("The repository has no commits to revert to.");
  }

  const projectRoot = resolveProjectPath(projectPath, ".");

  // Tracked changes (modified, deleted, renamed, staged adds). restore runs in
  // no-overlay mode, so files that are not in HEAD are removed from the index
  // and the working tree too.
  await runGitCommand(projectRoot, [
    "restore",
    "--source=HEAD",
    "--staged",
    "--worktree",
    "--",
    ".",
  ]);

  // Untracked files and directories. Ignored files (no -x) and nested repos
  // (no second -f) are left alone.
  await runGitCommand(projectRoot, ["clean", "-f", "-d", "--", "."]);

  return { reverted: true };
};

export const getProjectGitCachedDiff = async (
  projectPath,
  filePath,
  { previousPath = null, status },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);
  const repoRelativePath = normalizePath(
    path.relative(
      repoInfo.repoRoot,
      resolveProjectPath(projectPath, normalizedFilePath),
    ),
  );
  const diffResult = await runGitCommand(repoInfo.repoRoot, [
    "diff",
    "--cached",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    "--",
    repoRelativePath,
  ]);

  return {
    branch: repoInfo.branch,
    diff: diffResult.stdout,
    filePath: normalizedFilePath,
    parsedDiff: parseSingleFileDiff(diffResult.stdout),
    previousPath,
    status,
  };
};

/**
 * Fetch diffs for multiple changed files in bulk, minimizing git subprocess
 * spawns. Instead of calling getGitRepositoryInfo + getGitDiffBaseRef + git diff
 * per file, this resolves repo info and HEAD once, runs a single `git diff` for
 * all tracked files, and batches untracked file reads.
 *
 * @param {string} projectPath
 * @param {Array<{path: string, previousPath?: string, status: string}>} changes
 * @returns {Promise<string>} Combined diff text for all files.
 */
export const getProjectGitBulkDiff = async (projectPath, changes) => {
  if (changes.length === 0) {
    return "";
  }

  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const trackedChanges = changes.filter((c) => c.status !== "untracked");
  const untrackedChanges = changes.filter((c) => c.status === "untracked");

  const parts = [];

  // Single git diff for all tracked files
  if (trackedChanges.length > 0) {
    const baseRef = await getGitDiffBaseRef(repoInfo.repoRoot);
    const repoRelativePaths = trackedChanges.map((c) =>
      normalizePath(
        path.relative(
          repoInfo.repoRoot,
          resolveProjectPath(projectPath, normalizePath(c.path)),
        ),
      ),
    );

    const diffResult = await runGitCommand(repoInfo.repoRoot, [
      "diff",
      "--find-renames",
      "--no-ext-diff",
      "--submodule=diff",
      baseRef,
      "--",
      ...repoRelativePaths,
    ]);

    if (diffResult.stdout) {
      parts.push(diffResult.stdout);
    }
  }

  // Batch untracked file diffs (no git subprocess needed, just file reads)
  if (untrackedChanges.length > 0) {
    const untrackedDiffs = await Promise.all(
      untrackedChanges.map(async (c) => {
        try {
          return await buildUntrackedFileDiff(
            projectPath,
            normalizePath(c.path),
          );
        } catch {
          return "";
        }
      }),
    );

    for (const diff of untrackedDiffs) {
      if (diff) {
        parts.push(diff);
      }
    }
  }

  return parts.join("\n\n");
};

/**
 * Bulk cached (staged-only) diff. Same optimisation as getProjectGitBulkDiff
 * but uses `git diff --cached`.
 */
export const getProjectGitBulkCachedDiff = async (projectPath, changes) => {
  if (changes.length === 0) {
    return "";
  }

  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const repoRelativePaths = changes.map((c) =>
    normalizePath(
      path.relative(
        repoInfo.repoRoot,
        resolveProjectPath(projectPath, normalizePath(c.path)),
      ),
    ),
  );

  const diffResult = await runGitCommand(repoInfo.repoRoot, [
    "diff",
    "--cached",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    "--",
    ...repoRelativePaths,
  ]);

  return diffResult.stdout || "";
};

/**
 * Build a lightweight fingerprint for a set of git changes that can be used as
 * a cache key *without* fetching the full diff text. Uses the information
 * already available from `git status --porcelain=v2` (file paths, staging
 * state, line counts).
 */
export const getProjectGitChangesFingerprint = (
  changes,
  {
    customInstructions = "",
    includeUnstaged = true,
    modelSpeed = "standard",
    projectPath,
    provider,
    reasoningEffort,
  },
) =>
  hashContent(
    JSON.stringify({
      changes: changes
        .map((c) => ({
          addedLines: c.addedLines,
          path: c.path,
          previousPath: c.previousPath,
          removedLines: c.removedLines,
          staged: c.staged,
          status: c.status,
          unstaged: c.unstaged,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      customInstructions,
      includeUnstaged,
      modelSpeed,
      projectPath,
      provider,
      reasoningEffort,
    }),
  );
