import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parsePatchFiles } from "@pierre/diffs";
import { generateText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const MIME_TYPES = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const normalizePath = (value) => value.replace(/\\/g, "/");

const resolveProjectPath = (projectRoot, filePath) => {
  const root = path.resolve(projectRoot);
  const fullPath = path.resolve(root, filePath);
  if (fullPath === root) return fullPath;
  if (!fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside of the project root.");
  }
  return fullPath;
};

const hashContent = (content) =>
  createHash("sha256").update(content, "utf8").digest("hex");

const walkFiles = async (root, current, maxResults, output) => {
  if (output.length >= maxResults) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= maxResults) return;
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    if (entry.isDirectory() && BLOCKED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      await walkFiles(root, absolute, maxResults, output);
      continue;
    }
    output.push(relative);
  }
};

const listProjectFiles = async (projectRoot, directory, maxResults) => {
  const targetDirectory = resolveProjectPath(projectRoot, directory);
  const stats = await fs.stat(targetDirectory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
  const files = [];
  await walkFiles(projectRoot, targetDirectory, maxResults, files);
  return files;
};

const getCodexCliSpawnErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Codex CLI not found. Install it or add it to PATH, then restart Dream.";
  }

  return error instanceof Error ? error.message : "Codex CLI request failed.";
};

const resolveCodexCliLaunch = async () => {
  if (process.platform !== "win32") {
    return { argsPrefix: [], command: "codex" };
  }

  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-Command codex -ErrorAction Stop).Path"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    const resolvedPath = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!resolvedPath) {
      return { argsPrefix: [], command: "codex" };
    }

    const lowerResolvedPath = resolvedPath.toLowerCase();
    if (
      lowerResolvedPath.endsWith(".ps1") ||
      lowerResolvedPath.endsWith(".cmd")
    ) {
      const basedir = path.dirname(resolvedPath);
      const nodeExecutable = path.join(basedir, "node.exe");
      const codexEntrypoint = path.join(
        basedir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );

      return {
        argsPrefix: [codexEntrypoint],
        command: nodeExecutable,
      };
    }

    return { argsPrefix: [], command: resolvedPath };
  } catch {
    return { argsPrefix: [], command: "codex" };
  }
};

const parseCodexErrorPayload = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const getCodexErrorDetail = (event) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const directMessage =
    typeof event.message === "string" ? event.message.trim() : "";
  const parsedDirectMessage = parseCodexErrorPayload(directMessage);
  const nestedMessage =
    typeof event.error?.message === "string" ? event.error.message.trim() : "";
  const parsedNestedMessage = parseCodexErrorPayload(nestedMessage);

  return (
    parsedDirectMessage?.error?.message ||
    directMessage ||
    parsedNestedMessage?.error?.message ||
    nestedMessage ||
    null
  );
};

const projectFilesRequestSchema = z.object({
  directory: z.string().min(1).default("."),
  maxResults: z.number().int().min(1).max(5000).default(2000),
  projectPath: z.string().min(1),
});

const projectFileRequestSchema = z.object({
  endLine: z.number().int().min(1).optional(),
  filePath: z.string().min(1),
  projectPath: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
});

const projectIconRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitStatusRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitBranchesRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitCheckoutRequestSchema = z.object({
  branchName: z.string().min(1),
  create: z.boolean().default(false),
  projectPath: z.string().min(1),
});

const projectGitDiffRequestSchema = z.object({
  filePath: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  projectPath: z.string().min(1),
  status: z.enum([
    "modified",
    "added",
    "renamed",
    "copied",
    "deleted",
    "untracked",
  ]),
});

const nullableTrimmedStringSchema = z
  .string()
  .transform((value) => value.trim())
  .optional()
  .nullable();

const projectGitCommitRequestSchema = z.object({
  customInstructions: nullableTrimmedStringSchema,
  includeUnstaged: z.boolean().default(true),
  message: nullableTrimmedStringSchema,
  projectPath: z.string().min(1),
});

const projectGitCommitMessageRequestSchema = z.object({
  includeUnstaged: z.boolean().default(true),
  projectPath: z.string().min(1),
  provider: z.enum(["openai", "anthropic"]).default("openai"),
});

const projectGitPushRequestSchema = z.object({
  commitMessage: nullableTrimmedStringSchema,
  customInstructions: nullableTrimmedStringSchema,
  includeUnstaged: z.boolean().default(true),
  nextStep: z.enum(["push", "commit-push"]).default("push"),
  projectPath: z.string().min(1),
});

const projectGitPushPreviewRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitCreatePullRequestSchema = z.object({
  baseBranch: nullableTrimmedStringSchema,
  commitMessage: nullableTrimmedStringSchema,
  customInstructions: nullableTrimmedStringSchema,
  description: nullableTrimmedStringSchema,
  draft: z.boolean().default(true),
  includeUnstaged: z.boolean().default(true),
  nextStep: z
    .enum(["create", "push-create", "commit-push-create"])
    .default("create"),
  openPrPage: z.boolean().default(false),
  projectPath: z.string().min(1),
  title: nullableTrimmedStringSchema,
});

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const GH_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

const getGitCommandErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Git is not available on PATH.";
  }

  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";

  return stderr || stdout || "Git command failed.";
};

const runGitCommand = async (cwd, args, { allowFailure = false } = {}) => {
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

const runGhCommand = async (cwd, args, { allowFailure = false } = {}) => {
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

const getGitRepositoryInfo = async (projectPath) => {
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

const listProjectGitChanges = async (projectPath) => {
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

const listProjectGitBranches = async (projectPath) => {
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

const checkoutProjectGitBranch = async (projectPath, branchName, create) => {
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

const getProjectGitDiff = async (
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

const getProjectGitCachedDiff = async (
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

const normalizeGitActionText = (value) =>
  typeof value === "string" ? value.trim() : "";

const getGitActionBranchName = (branch) => {
  const normalizedBranch = normalizeGitActionText(branch);
  if (!normalizedBranch || normalizedBranch.startsWith("HEAD ")) {
    return null;
  }

  return normalizedBranch;
};

const ensureProjectGitRepository = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  return repoInfo;
};

const getProjectGitPathspec = (projectPath, repoRoot) => {
  const relativeProjectPath = normalizePath(
    path.relative(repoRoot, path.resolve(projectPath)),
  );

  return relativeProjectPath && relativeProjectPath !== "."
    ? relativeProjectPath
    : ".";
};

const listStagedGitPaths = async (repoRoot) => {
  const result = await runGitCommand(repoRoot, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);

  return result.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizePath);
};

const isGitPathInsidePathspec = (gitPath, pathspec) =>
  pathspec === "." ||
  gitPath === pathspec ||
  gitPath.startsWith(`${pathspec}/`);

const gitQuietDiffHasChanges = async (repoRoot, args) => {
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (result.ok) {
    return false;
  }

  if (result.error?.code === 1) {
    return true;
  }

  throw new Error(getGitCommandErrorMessage(result.error));
};

const getGitFileSubjectOverride = (filePath) => {
  switch (filePath) {
    case "src/components/ide/assistant-message-part.tsx":
      return "assistant message chips";
    case "src/components/ide/git-actions-menu.tsx":
      return "git action dialog behavior";
    default:
      return null;
  }
};

const formatGitFileSubject = (filePath) => {
  const override = getGitFileSubjectOverride(filePath);
  if (override) {
    return override;
  }

  const baseName = path
    .basename(filePath)
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return baseName || "project files";
};

const humanizeBranchName = (branch) => {
  const leaf = normalizeGitActionText(branch).split("/").filter(Boolean).pop();
  const words = (leaf || branch || "changes")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!words) {
    return "Changes";
  }

  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const describeGitChangeForMessage = (change) => {
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

const formatCommitSubjectList = (changes) => {
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

const getCommitMessageVerb = (changes) => {
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

const buildGeneratedCommitMessage = (changes, customInstructions) => {
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

  const instructions = normalizeGitActionText(customInstructions).toLowerCase();
  if (instructions.includes("conventional")) {
    return `chore: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
  }

  return subject;
};

const addUniqueCommitMessageSubject = (subjects, subject) => {
  if (!subjects.includes(subject)) {
    subjects.push(subject);
  }
};

const titleCaseCommitMessageSubject = (subject) =>
  subject ? `${subject.charAt(0).toUpperCase()}${subject.slice(1)}` : subject;

const joinCommitMessageSubjects = (subjects) => {
  if (subjects.length === 0) {
    return "";
  }

  const [firstSubject, ...restSubjects] = subjects;
  return [titleCaseCommitMessageSubject(firstSubject), ...restSubjects].join(
    " and ",
  );
};

const buildPathAwareCommitMessage = (changes) => {
  const paths = new Set(changes.map((change) => change.path));
  const subjects = [];

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

const buildDiffAwareCommitMessage = (changes, diffText, customInstructions) => {
  const normalizedDiff = diffText.toLowerCase();
  const subjects = [];

  if (
    normalizedDiff.includes("commit-push") ||
    normalizedDiff.includes("commit & push") ||
    (normalizedDiff.includes("project-git-push") &&
      normalizedDiff.includes('nextstep: "push"'))
  ) {
    addUniqueCommitMessageSubject(subjects, "separate commit-push flow");
  }

  if (
    normalizedDiff.includes("bumpprojectgitrefreshkey") &&
    normalizedDiff.includes("bumpprojectfilesrefreshkey")
  ) {
    addUniqueCommitMessageSubject(
      subjects,
      "refresh panels after assistant turns",
    );
  }

  const message = joinCommitMessageSubjects(subjects);
  return message || buildGeneratedCommitMessage(changes, customInstructions);
};

const sanitizeGeneratedCommitMessage = (value) => {
  const firstLine = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "";
  }

  return firstLine
    .replace(/^commit message:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
};

const truncateCommitMessageDiff = (diffText) => {
  if (diffText.length <= COMMIT_MESSAGE_DIFF_MAX_CHARS) {
    return diffText;
  }

  return `${diffText.slice(
    0,
    COMMIT_MESSAGE_DIFF_MAX_CHARS,
  )}\n\n[diff truncated]`;
};

const buildCommitMessagePrompt = ({ changes, diffText, fallbackMessage }) => {
  const changedFiles = changes
    .map((change) => `- ${change.status}: ${change.path}`)
    .join("\n");

  return [
    "Generate one concise git commit subject for these changes.",
    "Use imperative mood, no markdown, no quotes, no trailing period.",
    "Be specific about behavior, not just filenames.",
    "Return only the commit subject.",
    fallbackMessage ? `Reasonable fallback: ${fallbackMessage}` : null,
    "",
    "Changed files:",
    changedFiles,
    "",
    "Diff:",
    truncateCommitMessageDiff(diffText),
  ]
    .filter((part) => part !== null)
    .join("\n");
};

const getCommitMessageCacheKey = ({
  changes,
  customInstructions,
  diffText,
  includeUnstaged,
  projectPath,
  provider,
}) =>
  hashContent(
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
      customInstructions: normalizeGitActionText(customInstructions),
      diffHash: hashContent(diffText),
      includeUnstaged,
      projectPath: path.resolve(projectPath),
      provider,
    }),
  );

const setCommitMessageCacheEntry = (key, value) => {
  commitMessageCache.set(key, value);
  if (commitMessageCache.size <= COMMIT_MESSAGE_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = commitMessageCache.keys().next().value;
  if (oldestKey) {
    commitMessageCache.delete(oldestKey);
  }
};

const generateClaudeCommitMessage = async ({
  diffText,
  fallbackMessage,
  changes,
  projectPath,
}) => {
  const result = await generateText({
    model: claudeCode(COMMIT_MESSAGE_CLAUDE_MODEL, {
      continue: false,
      cwd: projectPath,
      persistSession: false,
      permissionMode: "plan",
    }),
    prompt: buildCommitMessagePrompt({ changes, diffText, fallbackMessage }),
    system:
      "You write concise, accurate git commit subjects. Return only the subject line.",
    temperature: 0.2,
  });

  return sanitizeGeneratedCommitMessage(result.text);
};

const generateCodexCommitMessage = async ({
  diffText,
  fallbackMessage,
  changes,
  projectPath,
}) =>
  new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let latestText = "";

    const prompt = [
      "You write concise, accurate git commit subjects.",
      buildCommitMessagePrompt({ changes, diffText, fallbackMessage }),
    ].join("\n\n");

    const finishWithText = () => {
      const sanitized = sanitizeGeneratedCommitMessage(latestText);
      resolve(sanitized);
    };

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "error" || event.type === "turn.failed") {
        const detail = getCodexErrorDetail(event);
        if (detail) {
          stderrBuffer += `${detail}\n`;
        }
        return;
      }

      const item = event.item;
      if (
        event.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        latestText = item.text;
      }
    };

    const handleStdoutChunk = (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          handleEvent(JSON.parse(trimmed));
        } catch {
          stderrBuffer += `${trimmed}\n`;
        }
      }
    };

    void resolveCodexCliLaunch()
      .then((launch) => {
        const child = spawn(
          launch.command,
          [
            ...launch.argsPrefix,
            "exec",
            "--json",
            "--cd",
            projectPath,
            "--skip-git-repo-check",
            "--model",
            COMMIT_MESSAGE_CODEX_MODEL,
            "-c",
            'sandbox_mode="read-only"',
            "-c",
            'approval_policy="never"',
            "-c",
            'model_reasoning_effort="low"',
            "-",
          ],
          {
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );

        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error) => {
          reject(new Error(getCodexCliSpawnErrorMessage(error)));
        });
        child.on("close", (code) => {
          const trimmed = stdoutBuffer.trim();
          if (trimmed) {
            try {
              handleEvent(JSON.parse(trimmed));
            } catch {
              stderrBuffer += `${trimmed}\n`;
            }
          }

          if (code === 0) {
            finishWithText();
            return;
          }

          reject(
            new Error(
              stderrBuffer.trim() || `Codex CLI exited with code ${code}.`,
            ),
          );
        });

        child.stdin.end(prompt);
      })
      .catch((error) => {
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "Codex CLI request failed.",
          ),
        );
      });
  });

const generateAiCommitMessage = async ({
  provider,
  diffText,
  fallbackMessage,
  changes,
  projectPath,
}) => {
  if (provider === "anthropic") {
    return generateClaudeCommitMessage({
      changes,
      diffText,
      fallbackMessage,
      projectPath,
    });
  }

  return generateCodexCommitMessage({
    changes,
    diffText,
    fallbackMessage,
    projectPath,
  });
};

const generateProjectGitCommitMessage = async (
  projectPath,
  { includeUnstaged = true, customInstructions = "", provider = "openai" } = {},
) => {
  const status = await listProjectGitChanges(projectPath);
  const changes = status.changes.filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  );

  if (changes.length === 0) {
    return "";
  }

  const diffPayloads = await Promise.all(
    changes.map(async (change) => {
      try {
        const diffPayload = includeUnstaged
          ? await getProjectGitDiff(projectPath, change.path, {
              previousPath: change.previousPath,
              status: change.status,
            })
          : await getProjectGitCachedDiff(projectPath, change.path, {
              previousPath: change.previousPath,
              status: change.status,
            });
        return diffPayload.diff || "";
      } catch {
        return "";
      }
    }),
  );

  const diffText = diffPayloads.join("\n\n");
  const fallbackMessage = buildDiffAwareCommitMessage(
    changes,
    diffText,
    customInstructions,
  );

  if (!diffText.trim()) {
    return fallbackMessage;
  }

  const cacheKey = getCommitMessageCacheKey({
    changes,
    customInstructions,
    diffText,
    includeUnstaged,
    projectPath,
    provider,
  });
  const cachedMessage = commitMessageCache.get(cacheKey);
  if (cachedMessage) {
    return cachedMessage;
  }

  const existingRequest = commitMessageRequests.get(cacheKey);
  if (existingRequest) {
    try {
      return await existingRequest;
    } catch {
      return fallbackMessage;
    }
  }

  const request = (async () => {
    const aiMessage = await generateAiCommitMessage({
      changes,
      diffText,
      fallbackMessage,
      projectPath,
      provider,
    });

    return aiMessage || fallbackMessage;
  })();
  commitMessageRequests.set(cacheKey, request);

  try {
    const message = await request;
    setCommitMessageCacheEntry(cacheKey, message);
    return message;
  } catch (error) {
    console.warn("[git] AI commit message generation failed:", error);
    setCommitMessageCacheEntry(cacheKey, fallbackMessage);
    return fallbackMessage;
  } finally {
    commitMessageRequests.delete(cacheKey);
  }
};

const commitProjectGitChanges = async (
  projectPath,
  { customInstructions = "", includeUnstaged = true, message = "" } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const projectPathspec = getProjectGitPathspec(projectPath, repoInfo.repoRoot);

  if (includeUnstaged) {
    await runGitCommand(repoInfo.repoRoot, [
      "add",
      "-A",
      "--",
      projectPathspec,
    ]);
  }

  const hasStagedChanges = await gitQuietDiffHasChanges(repoInfo.repoRoot, [
    "diff",
    "--cached",
    "--quiet",
    "--",
    projectPathspec,
  ]);
  if (!hasStagedChanges) {
    throw new Error("No staged changes to commit.");
  }

  const stagedPaths = await listStagedGitPaths(repoInfo.repoRoot);
  const outsideProjectStagedPaths = stagedPaths.filter(
    (gitPath) => !isGitPathInsidePathspec(gitPath, projectPathspec),
  );
  if (outsideProjectStagedPaths.length > 0) {
    throw new Error(
      "There are staged changes outside the active project. Commit them separately before using this action.",
    );
  }

  const statusBeforeCommit = await listProjectGitChanges(projectPath);
  const commitMessageChanges = statusBeforeCommit.changes.filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  );
  const commitMessage =
    normalizeGitActionText(message) ||
    (await generateProjectGitCommitMessage(projectPath, {
      customInstructions,
      includeUnstaged,
    })) ||
    buildGeneratedCommitMessage(commitMessageChanges, customInstructions);

  await runGitCommand(repoInfo.repoRoot, ["commit", "-m", commitMessage]);
  const commitHashResult = await runGitCommand(
    repoInfo.repoRoot,
    ["rev-parse", "--short", "HEAD"],
    { allowFailure: true },
  );

  return {
    commitHash: commitHashResult.ok ? commitHashResult.stdout.trim() : null,
    commitMessage,
    committed: true,
    status: await listProjectGitChanges(projectPath),
  };
};

const pushProjectGitChanges = async (
  projectPath,
  {
    commitMessage = "",
    customInstructions = "",
    includeUnstaged = true,
    nextStep = "push",
  } = {},
) => {
  let commit = null;
  if (nextStep === "commit-push") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  const repoInfo = await ensureProjectGitRepository(projectPath);
  const branch = getGitActionBranchName(repoInfo.branch);
  if (!branch) {
    throw new Error("Cannot push from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch);
  const args = metadata.upstreamBranch
    ? ["push"]
    : metadata.remoteName
      ? ["push", "-u", metadata.remoteName, branch]
      : null;

  if (!args) {
    throw new Error("No Git remote is configured for this repository.");
  }

  await runGitCommand(repoInfo.repoRoot, args);

  const status = await listProjectGitChanges(projectPath);
  return {
    branch,
    commit,
    pushed: true,
    status,
    upstreamBranch: status.upstreamBranch,
  };
};

const getPullRequestBaseRef = async (repoRoot, remoteName, baseBranch) => {
  if (!baseBranch) {
    return null;
  }

  if (
    remoteName &&
    (await gitRefExists(repoRoot, `refs/remotes/${remoteName}/${baseBranch}`))
  ) {
    return `${remoteName}/${baseBranch}`;
  }

  if (await gitRefExists(repoRoot, `refs/heads/${baseBranch}`)) {
    return baseBranch;
  }

  return null;
};

const parseGitPushPreviewCommit = (line) => {
  const [
    hash = "",
    shortHash = "",
    subject = "",
    authorName = "",
    authorDate = "",
  ] = line.split("\x1f");

  return {
    authorDate,
    authorName,
    hash,
    shortHash,
    subject,
  };
};

const readGitCommitCount = async (repoRoot, rangeRef) => {
  const args = rangeRef
    ? ["rev-list", "--count", rangeRef]
    : ["rev-list", "--count", "HEAD"];
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (!result.ok) {
    return 0;
  }

  return Number.parseInt(result.stdout.trim(), 10) || 0;
};

const readGitPushPreviewCommits = async (repoRoot, rangeRef) => {
  const args = [
    "log",
    "--max-count=50",
    "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI",
    ...(rangeRef ? [rangeRef] : ["HEAD"]),
  ];
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseGitPushPreviewCommit);
};

const getProjectGitPushPreview = async (projectPath) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const branch = getGitActionBranchName(repoInfo.branch);
  if (!branch) {
    throw new Error("Cannot push from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch);
  if (!metadata.upstreamBranch && !metadata.remoteName) {
    throw new Error("No Git remote is configured for this repository.");
  }

  const remoteBranchRef =
    metadata.remoteName &&
    (await gitRefExists(
      repoInfo.repoRoot,
      `refs/remotes/${metadata.remoteName}/${branch}`,
    ))
      ? `${metadata.remoteName}/${branch}`
      : null;
  const baseRef =
    metadata.upstreamBranch ||
    remoteBranchRef ||
    (await getPullRequestBaseRef(
      repoInfo.repoRoot,
      metadata.remoteName,
      metadata.baseBranch,
    ));
  const rangeRef = baseRef ? `${baseRef}..HEAD` : null;
  const [commits, totalCommits] = await Promise.all([
    readGitPushPreviewCommits(repoInfo.repoRoot, rangeRef),
    readGitCommitCount(repoInfo.repoRoot, rangeRef),
  ]);

  return {
    aheadCount: metadata.upstreamBranch ? metadata.aheadCount : totalCommits,
    baseRef,
    behindCount: metadata.behindCount,
    branch,
    commits,
    remoteName: metadata.remoteName,
    target: metadata.upstreamBranch ?? `${metadata.remoteName}/${branch}`,
    totalCommits,
    truncated: commits.length < totalCommits,
    upstreamBranch: metadata.upstreamBranch,
  };
};

const readPullRequestCommitSubjects = async (repoRoot, baseRef) => {
  const args = baseRef
    ? ["log", "--pretty=%s", `${baseRef}..HEAD`]
    : ["log", "--pretty=%s", "-n", "10"];
  const logResult = await runGitCommand(repoRoot, args, {
    allowFailure: true,
  });

  if (!logResult.ok) {
    return [];
  }

  return logResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const readPullRequestDiffStat = async (repoRoot, baseRef) => {
  if (!baseRef) {
    return "";
  }

  const diffResult = await runGitCommand(
    repoRoot,
    ["diff", "--stat", `${baseRef}...HEAD`],
    { allowFailure: true },
  );

  return diffResult.ok ? diffResult.stdout.trim() : "";
};

const buildGeneratedPullRequestTitle = (branch, commitSubjects) => {
  return commitSubjects[0] || humanizeBranchName(branch);
};

const buildGeneratedPullRequestBody = ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
}) => {
  const summaryItems =
    commitSubjects.length > 0
      ? commitSubjects.slice(0, 8)
      : [`Prepare ${humanizeBranchName(branch).toLowerCase()}`];
  const instructions = normalizeGitActionText(customInstructions).toLowerCase();
  const includeTesting =
    !instructions.includes("no test") && !instructions.includes("skip test");

  return [
    "## Summary",
    ...summaryItems.map((subject) => `- ${subject}`),
    diffStat ? "\n## Changes" : null,
    diffStat ? "```text" : null,
    diffStat || null,
    diffStat ? "```" : null,
    includeTesting ? "\n## Testing" : null,
    includeTesting ? "- Not run" : null,
  ]
    .filter(Boolean)
    .join("\n");
};

const parsePullRequestUrl = (output) => {
  const match = output.match(/https?:\/\/\S+/);
  return match?.[0] ?? null;
};

const createProjectPullRequest = async (
  projectPath,
  {
    baseBranch: requestedBaseBranch = "",
    commitMessage = "",
    customInstructions = "",
    description = "",
    draft = true,
    includeUnstaged = true,
    nextStep = "create",
    title = "",
  } = {},
) => {
  let commit = null;
  let push = null;

  if (nextStep === "commit-push-create") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  if (nextStep === "push-create" || nextStep === "commit-push-create") {
    push = await pushProjectGitChanges(projectPath, { nextStep: "push" });
  }

  const repoInfo = await ensureProjectGitRepository(projectPath);
  const headBranch = getGitActionBranchName(repoInfo.branch);
  if (!headBranch) {
    throw new Error("Cannot create a pull request from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, headBranch);
  const baseBranch =
    normalizeGitActionText(requestedBaseBranch) ||
    metadata.baseBranch ||
    "main";
  const baseRef = await getPullRequestBaseRef(
    repoInfo.repoRoot,
    metadata.remoteName,
    baseBranch,
  );
  const [commitSubjects, diffStat] = await Promise.all([
    readPullRequestCommitSubjects(repoInfo.repoRoot, baseRef),
    readPullRequestDiffStat(repoInfo.repoRoot, baseRef),
  ]);
  const pullRequestTitle =
    normalizeGitActionText(title) ||
    buildGeneratedPullRequestTitle(headBranch, commitSubjects);
  const pullRequestBody =
    normalizeGitActionText(description) ||
    buildGeneratedPullRequestBody({
      branch: headBranch,
      commitSubjects,
      customInstructions,
      diffStat,
    });

  const args = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    headBranch,
    "--title",
    pullRequestTitle,
    "--body",
    pullRequestBody,
  ];

  if (draft) {
    args.push("--draft");
  }

  const createResult = await runGhCommand(repoInfo.repoRoot, args);
  const output = `${createResult.stdout}\n${createResult.stderr}`.trim();

  return {
    baseBranch,
    commit,
    draft,
    headBranch,
    push,
    status: await listProjectGitChanges(projectPath),
    title: pullRequestTitle,
    url: parsePullRequestUrl(output),
  };
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

const ensureProjectDirectory = async (projectPath) => {
  const stats = await fs.stat(projectPath);
  if (!stats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }
};

const NEXT_ICON_CANDIDATES = [
  "src/app/favicon.ico",
  "app/favicon.ico",
  "src/app/icon.png",
  "src/app/icon.svg",
  "app/icon.png",
  "app/icon.svg",
  "src/app/apple-icon.png",
  "app/apple-icon.png",
];
const PUBLIC_ICON_CANDIDATES = [
  "public/favicon.ico",
  "public/favicon.svg",
  "public/icon.png",
  "public/icon.svg",
  "public/apple-touch-icon.png",
];
const ROOT_ICON_CANDIDATES = ["favicon.ico", "icon.png", "icon.svg"];
const WORKSPACE_DIRECTORY_NAMES = new Set(["apps", "packages"]);

const readJsonFile = async (absolutePath) => {
  try {
    return JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch {
    return null;
  }
};

const hasNextDependency = async (projectRoot) => {
  const packageJson = await readJsonFile(
    path.join(projectRoot, "package.json"),
  );
  if (!packageJson || typeof packageJson !== "object") {
    return false;
  }

  return Boolean(
    packageJson.dependencies?.next || packageJson.devDependencies?.next,
  );
};

const uniquePaths = (paths) => Array.from(new Set(paths.filter(Boolean)));

const getHtmlAttribute = (tag, attributeName) => {
  const pattern = new RegExp(
    `${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(pattern);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
};

const resolveIconHrefCandidates = (href) => {
  const cleanHref = href.split(/[?#]/)[0]?.trim();
  if (
    !cleanHref ||
    cleanHref.startsWith("data:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(cleanHref)
  ) {
    return [];
  }

  const withoutLeadingDot = cleanHref.replace(/^\.\//, "");
  const withoutLeadingSlash = withoutLeadingDot.replace(/^\/+/, "");
  if (!withoutLeadingSlash) {
    return [];
  }

  return uniquePaths([
    withoutLeadingSlash,
    `public/${withoutLeadingSlash}`,
  ]).map(normalizePath);
};

const readIndexHtmlIconCandidates = async (projectRoot) => {
  let html = "";
  try {
    html = await fs.readFile(path.join(projectRoot, "index.html"), "utf8");
  } catch {
    return [];
  }

  const candidates = [];
  const linkPattern = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const rel = getHtmlAttribute(tag, "rel").toLowerCase();
    if (!rel.split(/\s+/).includes("icon")) {
      continue;
    }

    candidates.push(
      ...resolveIconHrefCandidates(getHtmlAttribute(tag, "href")),
    );
  }

  return uniquePaths(candidates);
};

const findProjectIconCandidate = async (projectRoot, relativePath, source) => {
  const normalizedRelativePath = normalizePath(relativePath);
  const ext = path.extname(normalizedRelativePath).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType?.startsWith("image/")) {
    return null;
  }

  try {
    const absolutePath = resolveProjectPath(
      projectRoot,
      normalizedRelativePath,
    );
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return null;
    }

    return {
      path: normalizedRelativePath,
      mimeType,
      source,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
};

const detectIconAtProjectRoot = async (projectRoot) => {
  const isNextProject = await hasNextDependency(projectRoot);
  const htmlCandidates = await readIndexHtmlIconCandidates(projectRoot);
  const candidateGroups = isNextProject
    ? [
        ["next", NEXT_ICON_CANDIDATES],
        ["public", PUBLIC_ICON_CANDIDATES],
        ["root", ROOT_ICON_CANDIDATES],
        ["index-html", htmlCandidates],
      ]
    : [
        ["index-html", htmlCandidates],
        ["public", PUBLIC_ICON_CANDIDATES],
        ["root", ROOT_ICON_CANDIDATES],
        ["next", NEXT_ICON_CANDIDATES],
      ];

  for (const [source, candidates] of candidateGroups) {
    for (const candidate of candidates) {
      const icon = await findProjectIconCandidate(
        projectRoot,
        candidate,
        source,
      );
      if (icon) {
        return icon;
      }
    }
  }

  return null;
};

const getWorkspacePackagePatterns = async (projectRoot) => {
  const packageJson = await readJsonFile(
    path.join(projectRoot, "package.json"),
  );
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry) => typeof entry === "string");
  }
  if (Array.isArray(workspaces?.packages)) {
    return workspaces.packages.filter((entry) => typeof entry === "string");
  }
  return [];
};

const listWorkspaceRoots = async (projectRoot) => {
  const roots = [];
  const seen = new Set();
  const patterns = await getWorkspacePackagePatterns(projectRoot);
  for (const parentName of WORKSPACE_DIRECTORY_NAMES) {
    patterns.push(`${parentName}/*`);
  }

  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      continue;
    }

    const parent = pattern.slice(0, -2);
    let entries = [];
    try {
      entries = await fs.readdir(resolveProjectPath(projectRoot, parent), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const relativePath = normalizePath(path.join(parent, entry.name));
      if (seen.has(relativePath)) {
        continue;
      }

      seen.add(relativePath);
      roots.push({
        absolutePath: resolveProjectPath(projectRoot, relativePath),
        relativePath,
      });
    }
  }

  return roots.slice(0, 20);
};

const detectProjectIcon = async (projectPath) => {
  const projectRoot = path.resolve(projectPath);
  const rootIcon = await detectIconAtProjectRoot(projectRoot);
  if (rootIcon) {
    return rootIcon;
  }

  for (const workspaceRoot of await listWorkspaceRoots(projectRoot)) {
    const workspaceIcon = await detectIconAtProjectRoot(
      workspaceRoot.absolutePath,
    );
    if (!workspaceIcon) {
      continue;
    }

    return {
      ...workspaceIcon,
      path: normalizePath(
        path.join(workspaceRoot.relativePath, workspaceIcon.path),
      ),
      source: `workspace:${workspaceRoot.relativePath}:${workspaceIcon.source}`,
    };
  }

  return null;
};

export const registerProjectGitRoutes = (app) => {
  app.post("/api/project-files", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectFilesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { directory, maxResults, projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      const files = await listProjectFiles(projectPath, directory, maxResults);
      return c.json({ count: files.length, files });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to list files.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-file", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectFileRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { endLine, filePath, projectPath, startLine } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      const absolutePath = resolveProjectPath(projectPath, filePath);
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        return c.text(`Not a file: ${filePath}`, 400);
      }

      const fullText = await fs.readFile(absolutePath, "utf8");

      if (!startLine && !endLine) {
        return c.json({ content: fullText, filePath });
      }

      const lines = fullText.split(/\r?\n/);
      const safeStart = Math.max(1, startLine ?? 1);
      const safeEnd = Math.min(lines.length, endLine ?? lines.length);
      if (safeStart > safeEnd) {
        return c.text("startLine cannot be greater than endLine.", 400);
      }

      return c.json({
        content: lines.slice(safeStart - 1, safeEnd).join("\n"),
        endLine: safeEnd,
        filePath,
        startLine: safeStart,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read file.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-icon", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectIconRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    try {
      await ensureProjectDirectory(parsed.data.projectPath);
      return c.json({
        icon: await detectProjectIcon(parsed.data.projectPath),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to detect icon.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-status", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitStatusRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await listProjectGitChanges(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read Git status.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-branches", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitBranchesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await listProjectGitBranches(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read Git branches.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-checkout", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCheckoutRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { branchName, create, projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(
        await checkoutProjectGitBranch(projectPath, branchName, create),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to switch Git branches.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-commit", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCommitRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await commitProjectGitChanges(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to commit changes.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-commit-message", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCommitMessageRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json({
        commitMessage: await generateProjectGitCommitMessage(
          projectPath,
          options,
        ),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to generate commit message.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-push", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitPushRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await pushProjectGitChanges(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to push changes.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-push-preview", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitPushPreviewRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await getProjectGitPushPreview(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to preview push.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-create-pr", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCreatePullRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await createProjectPullRequest(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to create a pull request.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-diff", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitDiffRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { filePath, previousPath, projectPath, status } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(
        await getProjectGitDiff(projectPath, filePath, {
          previousPath,
          status,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read Git diff.";
      return c.text(message, 400);
    }
  });

  app.get("/api/project-file-raw", async (c) => {
    const projectPath = c.req.query("projectPath");
    const filePath = c.req.query("filePath");

    if (!projectPath || !filePath) {
      return c.text("Missing projectPath or filePath query parameter.", 400);
    }

    try {
      await ensureProjectDirectory(projectPath);
      const absolutePath = resolveProjectPath(projectPath, filePath);
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        return c.text(`Not a file: ${filePath}`, 400);
      }

      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = await fs.readFile(absolutePath);

      return new Response(data, {
        headers: { "Content-Type": contentType },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read file.";
      return c.text(message, 400);
    }
  });
};
