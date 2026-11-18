import { promises as fs, constants as fsConstants } from "node:fs";
import { TextDecoder } from "node:util";
import { HOST_ROUTES } from "../shared/host-routes.js";
import {
  commitProjectGitChanges,
  createProjectPullRequest,
  fetchProjectGitChanges,
  getProjectGitLog,
  getProjectGitPushPreview,
  getProjectGitRemoteUrl,
  pullProjectGitChanges,
  pushProjectGitChanges,
} from "./project-git/actions.js";
import {
  deleteProjectGitBranch,
  previewProjectGitBranchDelete,
} from "./project-git/branches.js";
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
import { generatedGitText } from "./project-git/generated-text.js";
import { detectProjectIcon } from "./project-git/icons.js";
import {
  projectDirectoryRequestSchema,
  projectFileRequestSchema,
  projectFilesRequestSchema,
  projectFileWriteRequestSchema,
  projectGitBranchDeletePreviewRequestSchema,
  projectGitBranchDeleteRequestSchema,
  projectGitBranchesRequestSchema,
  projectGitCheckoutRequestSchema,
  projectGitCommitMessageRequestSchema,
  projectGitCommitRequestSchema,
  projectGitCreatePullRequestSchema,
  projectGitCreateWorktreeRequestSchema,
  projectGitDiffRequestSchema,
  projectGitFetchRequestSchema,
  projectGitLogRequestSchema,
  projectGitPullRequestDetailsRequestSchema,
  projectGitPullRequestSchema,
  projectGitPushPreviewRequestSchema,
  projectGitPushRequestSchema,
  projectGitRemoteUrlRequestSchema,
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
  RouteError,
  registerProjectRoute,
} from "./shared/json-route.js";
import { registerRoute } from "./shared/register-route.js";

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
  registerProjectRoute(
    app,
    HOST_ROUTES.projectDirectory,
    projectDirectoryRequestSchema,
    ({ directory, projectPath }) =>
      listProjectDirectory(projectPath, directory),
    { errorMessage: "Unable to list directory." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.projectFiles,
    projectFilesRequestSchema,
    async ({ directory, maxResults, projectPath }, c) => {
      const files = await listProjectFiles(
        projectPath,
        directory,
        maxResults,
        c.req.raw.signal,
      );
      return { count: files.length, files };
    },
    { errorMessage: "Unable to list files." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.readProjectFile,
    projectFileRequestSchema,
    readProjectFile,
    { errorMessage: "Unable to read file." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.searchProjectFiles,
    projectSearchRequestSchema,
    (request, c) => searchProjectFiles(request, c.req.raw.signal),
    { errorMessage: "Unable to search files." },
  );

  registerRoute(app, HOST_ROUTES.writeProjectFile, (c) =>
    handleJsonRoute(c, projectFileWriteRequestSchema, writeProjectFile, {
      errorMessage: "Unable to save file.",
    }),
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.projectIcon,
    projectIconRequestSchema,
    async ({ projectPath }) => ({
      icon: await detectProjectIcon(projectPath),
    }),
    { errorMessage: "Unable to detect icon." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitStatus,
    projectGitStatusRequestSchema,
    ({ detail, projectPath }) =>
      listProjectGitChanges(projectPath, {
        includeMetadata: detail === "full",
        includeStats: detail === "full",
        includeUntracked: detail === "full",
      }),
    { errorMessage: "Unable to read Git status." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitBranches,
    projectGitBranchesRequestSchema,
    ({ projectPath }) => listProjectGitBranches(projectPath),
    { errorMessage: "Unable to read Git branches." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitCheckout,
    projectGitCheckoutRequestSchema,
    ({ branchName, create, projectPath }) =>
      checkoutProjectGitBranch(projectPath, branchName, create),
    { errorMessage: "Unable to switch Git branches." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitBranchDeletePreview,
    projectGitBranchDeletePreviewRequestSchema,
    ({ projectPath, ...options }) =>
      previewProjectGitBranchDelete(projectPath, options),
    { errorMessage: "Unable to check this branch." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitBranchDelete,
    projectGitBranchDeleteRequestSchema,
    ({ projectPath, ...options }) =>
      deleteProjectGitBranch(projectPath, options),
    { errorMessage: "Unable to delete branch." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitWorktrees,
    projectGitWorktreesRequestSchema,
    ({ projectPath }) => listProjectGitWorktrees(projectPath),
    { errorMessage: "Unable to read worktrees." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitWorktreeCreate,
    projectGitCreateWorktreeRequestSchema,
    ({ projectPath, ...options }) =>
      createProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to create worktree." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitCommit,
    projectGitCommitRequestSchema,
    ({ projectPath, ...options }) =>
      commitProjectGitChanges(projectPath, options),
    { errorMessage: "Unable to commit changes." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitCommitMessage,
    projectGitCommitMessageRequestSchema,
    async ({ projectPath, ...options }) => ({
      commitMessage: await generatedGitText.commitMessage(projectPath, {
        ...options,
        throwOnError: true,
      }),
    }),
    { errorMessage: "Unable to generate commit message." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitPush,
    projectGitPushRequestSchema,
    ({ projectPath, ...options }) =>
      pushProjectGitChanges(projectPath, options),
    { errorMessage: "Unable to push changes." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitFetch,
    projectGitFetchRequestSchema,
    ({ projectPath }) => fetchProjectGitChanges(projectPath),
    { errorMessage: "Unable to fetch changes." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitPull,
    projectGitPullRequestSchema,
    ({ projectPath }) => pullProjectGitChanges(projectPath),
    { errorMessage: "Unable to pull changes." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitRemoteUrl,
    projectGitRemoteUrlRequestSchema,
    ({ projectPath }) => getProjectGitRemoteUrl(projectPath),
    { errorMessage: "Unable to open repository." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitPushPreview,
    projectGitPushPreviewRequestSchema,
    ({ branch, projectPath }) =>
      getProjectGitPushPreview(projectPath, { branch }),
    { errorMessage: "Unable to preview push." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitLog,
    projectGitLogRequestSchema,
    ({ limit, projectPath, skip }) =>
      getProjectGitLog(projectPath, { limit, skip }),
    { errorMessage: "Unable to read Git history." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitCreatePullRequest,
    projectGitCreatePullRequestSchema,
    ({ projectPath, ...options }) =>
      createProjectPullRequest(projectPath, options),
    { errorMessage: "Unable to create a pull request." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitPullRequestDetails,
    projectGitPullRequestDetailsRequestSchema,
    ({ projectPath, ...options }) =>
      generatedGitText.pullRequestDetails(projectPath, options),
    { errorMessage: "Unable to generate pull request details." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitWorktreeCompare,
    projectGitWorktreeCompareRequestSchema,
    ({ projectPath, ...options }) =>
      compareProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to compare worktree." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitWorktreeCompareDiff,
    projectGitWorktreeCompareDiffRequestSchema,
    ({ projectPath, ...options }) =>
      getProjectGitWorktreeCompareDiff(projectPath, options),
    { errorMessage: "Unable to read worktree diff." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitWorktreeMerge,
    projectGitWorktreeMergeRequestSchema,
    ({ projectPath, ...options }) =>
      mergeProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to merge worktree." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitWorktreeCleanup,
    projectGitWorktreeCleanupRequestSchema,
    ({ projectPath, ...options }) =>
      forgetProjectGitWorktree(projectPath, options),
    { errorMessage: "Unable to remove worktree." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitDiff,
    projectGitDiffRequestSchema,
    ({ filePath, previousPath, projectPath, status }) =>
      getProjectGitDiff(projectPath, filePath, { previousPath, status }),
    { errorMessage: "Unable to read Git diff." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitRevertFile,
    projectGitRevertFileRequestSchema,
    ({ filePath, previousPath, projectPath, status }) =>
      revertProjectGitFile(projectPath, filePath, { previousPath, status }),
    { errorMessage: "Unable to revert file." },
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.gitRevertAll,
    projectGitRevertAllRequestSchema,
    ({ projectPath }) => revertAllProjectGitChanges(projectPath),
    { errorMessage: "Unable to revert changes." },
  );

  registerRoute(app, HOST_ROUTES.projectFileRaw, async (c) => {
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

  registerRoute(app, HOST_ROUTES.gitFileAtHeadRaw, async (c) => {
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
