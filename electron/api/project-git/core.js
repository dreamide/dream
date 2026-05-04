import { promises as fs } from "node:fs";
import path from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { execFileAsync } from "../shared/cli.js";
import { normalizePath, resolveProjectPath } from "./files.js";

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const GH_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

export const getGitCommandErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Git is not available on PATH.";
  }

  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";

  return stderr || stdout || "Git command failed.";
};

export const runGitCommand = async (
  cwd,
  args,
  { allowFailure = false } = {},
) => {
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

const isGitRepositoryError = (result) => {
  if (result.ok) {
    return false;
  }

  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    message.includes("not a git repository") ||
    message.includes("outside repository")
  );
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

const getPreferredGitRemote = async (repoRoot) => {
  const remoteResult = await runGitCommand(repoRoot, ["remote"], {
    allowFailure: true,
  });
  if (!remoteResult.ok) {
    return null;
  }

  const remotes = remoteResult.stdout
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter(Boolean);

  if (remotes.length === 0) {
    return null;
  }

  return remotes.includes("origin") ? "origin" : remotes[0];
};

const gitRefExists = async (repoRoot, ref) => {
  const result = await runGitCommand(
    repoRoot,
    ["show-ref", "--verify", "--quiet", ref],
    { allowFailure: true },
  );

  return result.ok;
};

const getGitDefaultBranch = async (repoRoot, remoteName) => {
  if (remoteName) {
    const remoteHeadResult = await runGitCommand(
      repoRoot,
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remoteName}/HEAD`],
      { allowFailure: true },
    );
    if (remoteHeadResult.ok) {
      const remoteHead = remoteHeadResult.stdout.trim();
      if (remoteHead.startsWith(`${remoteName}/`)) {
        return remoteHead.slice(remoteName.length + 1);
      }
      if (remoteHead) {
        return remoteHead;
      }
    }
  }

  for (const branchName of ["main", "master"]) {
    if (await gitRefExists(repoRoot, `refs/heads/${branchName}`)) {
      return branchName;
    }

    if (
      remoteName &&
      (await gitRefExists(repoRoot, `refs/remotes/${remoteName}/${branchName}`))
    ) {
      return branchName;
    }
  }

  return null;
};

const getCurrentGitUpstream = async (repoRoot) => {
  const upstreamResult = await runGitCommand(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { allowFailure: true },
  );

  return upstreamResult.ok ? upstreamResult.stdout.trim() || null : null;
};

const getGitAheadBehindCounts = async (repoRoot, upstreamBranch) => {
  if (!upstreamBranch) {
    return {
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const countsResult = await runGitCommand(
    repoRoot,
    ["rev-list", "--left-right", "--count", `${upstreamBranch}...HEAD`],
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

const getProjectGitMetadata = async (repoRoot, branch) => {
  const remoteName = await getPreferredGitRemote(repoRoot);
  const [baseBranch, upstreamBranch] = await Promise.all([
    getGitDefaultBranch(repoRoot, remoteName),
    branch?.startsWith("HEAD ")
      ? Promise.resolve(null)
      : getCurrentGitUpstream(repoRoot),
  ]);
  const { aheadCount, behindCount } = await getGitAheadBehindCounts(
    repoRoot,
    upstreamBranch,
  );

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

  if (
    absolutePath !== projectRoot &&
    !absolutePath.startsWith(`${projectRoot}${path.sep}`)
  ) {
    return null;
  }

  return normalizePath(path.relative(projectRoot, absolutePath));
};

export const getGitRepositoryInfo = async (projectPath) => {
  const repoResult = await runGitCommand(
    projectPath,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );

  if (!repoResult.ok) {
    if (isGitRepositoryError(repoResult)) {
      return {
        branch: null,
        isRepo: false,
        repoRoot: null,
      };
    }

    throw new Error(getGitCommandErrorMessage(repoResult.error));
  }

  const repoRoot = repoResult.stdout.trim();
  const branchResult = await runGitCommand(
    repoRoot,
    ["branch", "--show-current"],
    { allowFailure: true },
  );
  let branch = branchResult.ok ? branchResult.stdout.trim() : "";

  if (!branch) {
    const detachedHeadResult = await runGitCommand(
      repoRoot,
      ["rev-parse", "--short", "HEAD"],
      { allowFailure: true },
    );
    if (detachedHeadResult.ok) {
      const revision = detachedHeadResult.stdout.trim();
      branch = revision ? `HEAD ${revision}` : "";
    }
  }

  return {
    branch: branch || null,
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

export const listProjectGitChanges = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    return {
      addedLines: 0,
      aheadCount: 0,
      baseBranch: null,
      branch: repoInfo.branch,
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

  const statusResult = await runGitCommand(repoInfo.repoRoot, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = statusResult.stdout.split("\0").filter(Boolean);
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
  const statsByPath = await getProjectGitChangeStats(
    projectPath,
    repoInfo.repoRoot,
    changes,
  );

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
  const metadata = await getProjectGitMetadata(
    repoInfo.repoRoot,
    repoInfo.branch,
  );

  return {
    ...metadata,
    branch: repoInfo.branch,
    changes: enrichedChanges,
    isRepo: true,
    repoRoot: repoInfo.repoRoot,
    ...summarizeProjectGitChanges(enrichedChanges),
  };
};

export const listProjectGitBranches = async (projectPath) => {
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

const validateProjectGitBranchName = async (repoRoot, branchName) => {
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

const getProjectGitChangeStats = async (projectPath, repoRoot, changes) => {
  const statsByPath = new Map();
  const trackedPaths = changes
    .filter((change) => change.status !== "untracked")
    .map((change) =>
      normalizePath(
        path.relative(repoRoot, resolveProjectPath(projectPath, change.path)),
      ),
    );

  if (trackedPaths.length > 0) {
    const baseRef = await getGitDiffBaseRef(repoRoot);
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

const parseSingleFileDiff = (patch) => {
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
