import { promises as fs, constants as fsConstants } from "node:fs";
import { TextDecoder } from "node:util";
import {
  commitProjectGitChanges,
  createProjectPullRequest,
  generateProjectGitCommitMessage,
  generateProjectPullRequestDetails,
  getProjectGitLog,
  getProjectGitPushPreview,
  pushProjectGitChanges,
} from "./project-git/actions.js";
import {
  checkoutProjectGitBranch,
  getProjectGitDiff,
  getProjectGitFileAtHead,
  listProjectGitBranches,
  listProjectGitChanges,
  revertAllProjectGitChanges,
  revertProjectGitFile,
} from "./project-git/core.js";
import {
  ensureProjectDirectory,
  isLikelyBinaryBuffer,
  listProjectDirectory,
  listProjectFiles,
  MIME_TYPES,
  resolveProjectPath,
} from "./project-git/files.js";
import { detectProjectIcon } from "./project-git/icons.js";
import {
  projectDirectoryRequestSchema,
  projectFileRequestSchema,
  projectFilesRequestSchema,
  projectFileWriteRequestSchema,
  projectGitBranchesRequestSchema,
  projectGitCheckoutRequestSchema,
  projectGitCommitMessageRequestSchema,
  projectGitCommitRequestSchema,
  projectGitCreatePullRequestSchema,
  projectGitCreateWorktreeRequestSchema,
  projectGitDiffRequestSchema,
  projectGitLogRequestSchema,
  projectGitPullRequestDetailsRequestSchema,
  projectGitPushPreviewRequestSchema,
  projectGitPushRequestSchema,
  projectGitRevertAllRequestSchema,
  projectGitRevertFileRequestSchema,
  projectGitStatusRequestSchema,
  projectGitWorktreeCleanupRequestSchema,
  projectGitWorktreeCompareDiffRequestSchema,
  projectGitWorktreeCompareRequestSchema,
  projectGitWorktreeMergeRequestSchema,
  projectGitWorktreesRequestSchema,
  projectIconRequestSchema,
  projectSearchRequestSchema,
} from "./project-git/schemas.js";
import { searchProjectFiles } from "./project-git/search.js";
import {
  compareProjectGitWorktree,
  createProjectGitWorktree,
  forgetProjectGitWorktree,
  getProjectGitWorktreeCompareDiff,
  listProjectGitWorktrees,
  mergeProjectGitWorktree,
} from "./project-git/worktree-lifecycle.js";
import {
  handleJsonRoute,
  postProjectRoute,
  RouteError,
} from "./shared/json-route.js";

const PROJECT_FILE_PREVIEW_MAX_BYTES = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const detectProjectFileLineEnding = (content) =>
  content.includes("\r\n") ? "crlf" : "lf";

export const serializeProjectFileContent = (content, lineEnding) =>
  lineEnding === "crlf" ? content.replace(/\r?\n/g, "\r\n") : content;

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
};

const resolveRealProjectFilePath = async (projectPath, filePath) => {
  const projectRoot = await fs.realpath(projectPath);
  const absolutePath = resolveProjectPath(projectPath, filePath);
  const realAbsolutePath = await fs.realpath(absolutePath);
  resolveProjectPath(projectRoot, realAbsolutePath);
  return realAbsolutePath;
};

const getProjectFileWritability = async (absolutePath) => {
  try {
    await fs.access(absolutePath, fsConstants.W_OK);
    return { readOnlyReason: null, writable: true };
  } catch {
    return {
      readOnlyReason:
        "This file is read-only because Dream does not have permission to write it.",
      writable: false,
    };
  }
};

const readProjectFile = async ({
  endLine,
  filePath,
  projectPath,
  startLine,
}) => {
  const absolutePath = await resolveRealProjectFilePath(projectPath, filePath);
  const stats = await fs.stat(absolutePath);
  if (!stats.isFile()) {
    throw new RouteError(`Not a file: ${filePath}`, 400);
  }

  if (stats.size > PROJECT_FILE_PREVIEW_MAX_BYTES) {
    throw new RouteError(
      `Files larger than ${formatBytes(PROJECT_FILE_PREVIEW_MAX_BYTES)} are not previewed.`,
      413,
    );
  }

  const fullData = await fs.readFile(absolutePath);
  if (isLikelyBinaryBuffer(fullData)) {
    throw new RouteError("Binary files cannot be previewed.", 415);
  }

  const fullText = utf8Decoder.decode(fullData);
  const lineEnding = detectProjectFileLineEnding(fullText);
  const writability = await getProjectFileWritability(absolutePath);

  if (!startLine && !endLine) {
    return { content: fullText, filePath, lineEnding, ...writability };
  }

  const lines = fullText.split(/\r?\n/);
  const safeStart = Math.max(1, startLine ?? 1);
  const safeEnd = Math.min(lines.length, endLine ?? lines.length);
  if (safeStart > safeEnd) {
    throw new RouteError("startLine cannot be greater than endLine.", 400);
  }

  return {
    content: lines.slice(safeStart - 1, safeEnd).join("\n"),
    endLine: safeEnd,
    filePath,
    lineEnding,
    startLine: safeStart,
    ...writability,
  };
};

const tooLargeToEdit = () =>
  new RouteError(
    `Files larger than ${formatBytes(PROJECT_FILE_PREVIEW_MAX_BYTES)} cannot be edited here.`,
    413,
  );

const writeProjectFile = async ({
  content,
  expectedContent,
  filePath,
  projectPath,
}) => {
  // Checked before touching the disk, so an oversized save fails fast.
  if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_PREVIEW_MAX_BYTES) {
    throw tooLargeToEdit();
  }

  await ensureProjectDirectory(projectPath);
  const realAbsolutePath = await resolveRealProjectFilePath(
    projectPath,
    filePath,
  );

  const stats = await fs.stat(realAbsolutePath);
  if (!stats.isFile()) {
    throw new RouteError(`Not a file: ${filePath}`, 400);
  }

  if (stats.size > PROJECT_FILE_PREVIEW_MAX_BYTES) {
    throw new RouteError(
      "The file changed on disk and is now too large to edit here.",
      409,
    );
  }

  const writability = await getProjectFileWritability(realAbsolutePath);
  if (!writability.writable) {
    throw new RouteError(writability.readOnlyReason, 403);
  }

  const currentData = await fs.readFile(realAbsolutePath);
  if (isLikelyBinaryBuffer(currentData)) {
    throw new RouteError("Binary files cannot be edited.", 415);
  }

  const currentContent = utf8Decoder.decode(currentData);
  if (currentContent !== expectedContent) {
    throw new RouteError(
      "The file changed on disk after editing began. Reopen it before saving.",
      409,
    );
  }

  const lineEnding = detectProjectFileLineEnding(currentContent);
  const serializedContent = serializeProjectFileContent(content, lineEnding);
  if (
    Buffer.byteLength(serializedContent, "utf8") >
    PROJECT_FILE_PREVIEW_MAX_BYTES
  ) {
    throw tooLargeToEdit();
  }

  await fs.writeFile(realAbsolutePath, serializedContent, "utf8");
  return { content: serializedContent, filePath, lineEnding };
};

export const registerProjectGitRoutes = (app) => {
  postProjectRoute(
    app,
    "/api/project-directory",
    projectDirectoryRequestSchema,
    ({ directory, projectPath }) =>
      listProjectDirectory(projectPath, directory),
    { errorMessage: "Unable to list directory." },
  );

  postProjectRoute(
    app,
    "/api/project-files",
    projectFilesRequestSchema,
    async ({ directory, maxResults, projectPath }) => {
      const files = await listProjectFiles(projectPath, directory, maxResults);
      return { count: files.length, files };
    },
    { errorMessage: "Unable to list files." },
  );

  postProjectRoute(
    app,
    "/api/project-file",
    projectFileRequestSchema,
    readProjectFile,
    { errorMessage: "Unable to read file." },
  );

  postProjectRoute(
    app,
    "/api/project-search",
    projectSearchRequestSchema,
    (request, c) => searchProjectFiles(request, c.req.raw.signal),
    { errorMessage: "Unable to search files." },
  );

  app.put("/api/project-file", (c) =>
    handleJsonRoute(c, projectFileWriteRequestSchema, writeProjectFile, {
      errorMessage: "Unable to save file.",
    }),
  );

  postProjectRoute(
    app,
    "/api/project-icon",
    projectIconRequestSchema,
    async ({ projectPath }) => ({
      icon: await detectProjectIcon(projectPath),
    }),
    { errorMessage: "Unable to detect icon." },
  );

  postProjectRoute(
    app,
    "/api/project-git-status",
    projectGitStatusRequestSchema,
    ({ detail, projectPath }) =>
      listProjectGitChanges(projectPath, {
        includeMetadata: detail === "full",
        includeStats: detail === "full",
        includeUntracked: detail === "full",
      }),
    { errorMessage: "Unable to read Git status." },
  );

  postProjectRoute(
    app,
    "/api/project-git-branches",
    projectGitBranchesRequestSchema,
    ({ projectPath }) => listProjectGitBranches(projectPath),
    { errorMessage: "Unable to read Git branches." },
  );

  postProjectRoute(
    app,
    "/api/project-git-checkout",
    projectGitCheckoutRequestSchema,
    ({ branchName, create, projectPath }) =>
      checkoutProjectGitBranch(projectPath, branchName, create),
    { errorMessage: "Unable to switch Git branches." },
  );

  postProjectRoute(
    app,
    "/api/project-git-worktrees",
    projectGitWorktreesRequestSchema,
    ({ projectPath }) => listProjectGitWorktrees(projectPath),
    { errorMessage: "Unable to read worktrees." },
  );

  postProjectRoute(
    app,
    "/api/project-git-worktree-create",
    projectGitCreateWorktreeRequestSchema,
    ({ projectPath, ...options }) =>
      createProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to create worktree." },
  );

  postProjectRoute(
    app,
    "/api/project-git-commit",
    projectGitCommitRequestSchema,
    ({ projectPath, ...options }) =>
      commitProjectGitChanges(projectPath, options),
    { errorMessage: "Unable to commit changes." },
  );

  postProjectRoute(
    app,
    "/api/project-git-commit-message",
    projectGitCommitMessageRequestSchema,
    async ({ projectPath, ...options }) => ({
      commitMessage: await generateProjectGitCommitMessage(projectPath, {
        ...options,
        throwOnError: true,
      }),
    }),
    { errorMessage: "Unable to generate commit message." },
  );

  postProjectRoute(
    app,
    "/api/project-git-push",
    projectGitPushRequestSchema,
    ({ projectPath, ...options }) =>
      pushProjectGitChanges(projectPath, options),
    { errorMessage: "Unable to push changes." },
  );

  postProjectRoute(
    app,
    "/api/project-git-push-preview",
    projectGitPushPreviewRequestSchema,
    ({ branch, projectPath }) =>
      getProjectGitPushPreview(projectPath, { branch }),
    { errorMessage: "Unable to preview push." },
  );

  postProjectRoute(
    app,
    "/api/project-git-log",
    projectGitLogRequestSchema,
    ({ limit, projectPath, skip }) =>
      getProjectGitLog(projectPath, { limit, skip }),
    { errorMessage: "Unable to read Git history." },
  );

  postProjectRoute(
    app,
    "/api/project-git-create-pr",
    projectGitCreatePullRequestSchema,
    ({ projectPath, ...options }) =>
      createProjectPullRequest(projectPath, options),
    { errorMessage: "Unable to create a pull request." },
  );

  postProjectRoute(
    app,
    "/api/project-git-pull-request-details",
    projectGitPullRequestDetailsRequestSchema,
    ({ projectPath, ...options }) =>
      generateProjectPullRequestDetails(projectPath, options),
    { errorMessage: "Unable to generate pull request details." },
  );

  postProjectRoute(
    app,
    "/api/project-git-worktree-compare",
    projectGitWorktreeCompareRequestSchema,
    ({ projectPath, ...options }) =>
      compareProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to compare worktree." },
  );

  postProjectRoute(
    app,
    "/api/project-git-worktree-compare-diff",
    projectGitWorktreeCompareDiffRequestSchema,
    ({ projectPath, ...options }) =>
      getProjectGitWorktreeCompareDiff(projectPath, options),
    { errorMessage: "Unable to read worktree diff." },
  );

  postProjectRoute(
    app,
    "/api/project-git-worktree-merge",
    projectGitWorktreeMergeRequestSchema,
    ({ projectPath, ...options }) =>
      mergeProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to merge worktree." },
  );

  postProjectRoute(
    app,
    "/api/project-git-worktree-cleanup",
    projectGitWorktreeCleanupRequestSchema,
    ({ projectPath, ...options }) =>
      forgetProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to remove worktree." },
  );

  postProjectRoute(
    app,
    "/api/project-git-diff",
    projectGitDiffRequestSchema,
    ({ filePath, previousPath, projectPath, status }) =>
      getProjectGitDiff(projectPath, filePath, { previousPath, status }),
    { errorMessage: "Unable to read Git diff." },
  );

  postProjectRoute(
    app,
    "/api/project-git-revert-file",
    projectGitRevertFileRequestSchema,
    ({ filePath, previousPath, projectPath, status }) =>
      revertProjectGitFile(projectPath, filePath, { previousPath, status }),
    { errorMessage: "Unable to revert file." },
  );

  postProjectRoute(
    app,
    "/api/project-git-revert-all",
    projectGitRevertAllRequestSchema,
    ({ projectPath }) => revertAllProjectGitChanges(projectPath),
    { errorMessage: "Unable to revert changes." },
  );

  app.get("/api/project-file-raw", async (c) => {
    const projectPath = c.req.query("projectPath");
    const filePath = c.req.query("filePath");

    if (!projectPath || !filePath) {
      return c.text("Missing projectPath or filePath query parameter.", 400);
    }

    try {
      await ensureProjectDirectory(projectPath);
      const absolutePath = await resolveRealProjectFilePath(
        projectPath,
        filePath,
      );
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

  app.get("/api/project-git-file-at-head-raw", async (c) => {
    const projectPath = c.req.query("projectPath");
    const filePath = c.req.query("filePath");

    if (!projectPath || !filePath) {
      return c.text("Missing projectPath or filePath query parameter.", 400);
    }

    try {
      await ensureProjectDirectory(projectPath);
      const { data } = await getProjectGitFileAtHead(projectPath, filePath);
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      return new Response(data, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": contentType,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to read the file from Git history.";
      return c.text(message, 400);
    }
  });
};
